#import "siri_tts_bridge.h"

#import <AVFoundation/AVFoundation.h>
#import <AudioToolbox/AudioToolbox.h>
#import <Foundation/Foundation.h>
#import <math.h>
#import <dlfcn.h>
#import <objc/message.h>
#import <objc/runtime.h>

static NSString *const BerdSiriTTSErrorDomain = @"com.block.berd.sirittsd";
static void *BerdSiriSpeechQueueKey = &BerdSiriSpeechQueueKey;

@protocol BerdSiriTTSAvailabilityProtocol <NSObject>
- (void)downloadedVoicesMatching:(id)voice
                           reply:(void (^)(NSArray *voices))reply;
@end

@protocol BerdSiriTTSSubscribeProtocol <NSObject>
- (void)subscribeWithVoices:(NSArray *)voices
                   clientId:(NSString *)clientId
                accessoryId:(NSString *)accessoryId
                      reply:(void (^)(NSError *_Nullable error))reply;
@end

@protocol BerdSiriTTSDaemonProtocol <NSObject>
- (void)synthesizeWithRequest:(id)request
                        reply:(void (^)(NSError *_Nullable error))reply;
- (void)cancelWithRequest:(id)request;
@end

@protocol BerdSiriTTSSessionDelegate <NSObject>
- (void)didGenerateAudioWithRequestId:(uint64_t)requestId audio:(id)audio;
- (void)didGenerateWordTimingsWithRequestId:(uint64_t)requestId wordTimingInfo:(id)info;
- (void)didReportInstrumentWithRequestId:(uint64_t)requestId instrumentationMetrics:(id)metrics;
- (void)didStartSpeakingWithRequestId:(uint64_t)requestId;
- (void)pingWithReply:(void (^)(void))reply;
- (void)event:(uint64_t)event eventData:(id)data;
- (void)internalEvent:(uint64_t)event internalEventData:(id)data;
@end

static NSError *BerdError(NSInteger code, NSString *message) {
    return [NSError errorWithDomain:BerdSiriTTSErrorDomain
                               code:code
                           userInfo:@{NSLocalizedDescriptionKey : message}];
}

static void BerdSetError(char **errorOut, NSError *error) {
    if (!errorOut || !error) return;
    *errorOut = strdup(error.localizedDescription.UTF8String ?: "Siri TTS failed");
}

static BOOL BerdLoadFramework(NSString *path, NSError **error) {
    if (dlopen(path.UTF8String, RTLD_NOW) != NULL) return YES;
    if (error) {
        const char *detail = dlerror();
        NSString *message = detail
            ? [NSString stringWithUTF8String:detail]
            : [NSString stringWithFormat:@"Could not load %@", path.lastPathComponent];
        *error = BerdError(1, message);
    }
    return NO;
}

static BOOL BerdLoadSiriTTS(NSError **error) {
    return BerdLoadFramework(
        @"/System/Library/PrivateFrameworks/SiriTTSService.framework/SiriTTSService",
        error
    );
}

static NSSet<Class> *BerdRequestClasses(void) {
    NSMutableSet<Class> *classes = [NSMutableSet setWithObjects:
        NSString.class, NSNumber.class, NSData.class, NSURL.class,
        NSUUID.class, NSValue.class, NSArray.class, NSDictionary.class,
        NSError.class, nil];
    for (NSString *name in @[
        @"SiriTTSSynthesisRequest", @"SiriTTSSpeechRequest",
        @"SiriTTSSynthesisVoice", @"SiriTTSBaseRequest",
        @"SiriTTSAudibleContext", @"SiriTTSSynthesisContext",
        @"SiriTTSProsodyProperties"
    ]) {
        Class cls = objc_getClass(name.UTF8String);
        if (cls) [classes addObject:cls];
    }
    return classes;
}

static NSSet<Class> *BerdCallbackClasses(void) {
    NSMutableSet<Class> *classes = [BerdRequestClasses() mutableCopy];
    for (NSString *name in @[
        @"SiriTTSAudioData", @"SiriTTSWordTimingInfo",
        @"SiriTTSInstrumentationMetrics"
    ]) {
        Class cls = objc_getClass(name.UTF8String);
        if (cls) [classes addObject:cls];
    }
    return classes;
}

static id BerdCreateVoice(NSString *language, NSString *name, NSError **error) {
    if (!BerdLoadSiriTTS(error)) return nil;
    Class cls = objc_getClass("SiriTTSSynthesisVoice");
    SEL selector = @selector(initWithLanguage:name:);
    if (!cls || ![cls instancesRespondToSelector:selector]) {
        if (error) *error = BerdError(2, @"Siri voices are unavailable on this macOS version.");
        return nil;
    }
    typedef id (*InitializeVoice)(id, SEL, id, id);
    InitializeVoice initialize = (InitializeVoice)objc_msgSend;
    return initialize([cls alloc], selector, language, name);
}

static NSDictionary<NSString *, id> *BerdVoiceDictionary(id voice) {
    return @{
        @"name" : [voice valueForKey:@"name"] ?: @"",
        @"language" : [voice valueForKey:@"language"] ?: @"",
        @"version" : [voice valueForKey:@"version"] ?: @0,
    };
}

typedef void (^BerdAudioHandler)(
    NSData *data,
    AudioStreamBasicDescription format,
    UInt32 packetCount,
    NSData *_Nullable packetDescriptions
);

@interface BerdSiriSessionDelegateImpl : NSObject <BerdSiriTTSSessionDelegate>
@property(nonatomic, copy) BerdAudioHandler audioHandler;
@end

@implementation BerdSiriSessionDelegateImpl
- (void)didGenerateAudioWithRequestId:(uint64_t)requestId audio:(id)audio {
    (void)requestId;
    NSData *data = [audio valueForKey:@"audioData"];
    if (!data.length) return;
    NSNumber *packetCount = [audio valueForKey:@"packetCount"] ?: @1;
    NSData *packetDescriptions = [audio valueForKey:@"packetDescriptions"];
    SEL selector = NSSelectorFromString(@"asbd");
    if (![audio respondsToSelector:selector]) return;
    typedef AudioStreamBasicDescription (*GetASBD)(id, SEL);
    GetASBD getASBD = (GetASBD)[audio methodForSelector:selector];
    self.audioHandler(data, getASBD(audio, selector),
                      packetCount.unsignedIntValue, packetDescriptions);
}
- (void)didGenerateWordTimingsWithRequestId:(uint64_t)requestId wordTimingInfo:(id)info {
    (void)requestId; (void)info;
}
- (void)didReportInstrumentWithRequestId:(uint64_t)requestId instrumentationMetrics:(id)metrics {
    (void)requestId; (void)metrics;
}
- (void)didStartSpeakingWithRequestId:(uint64_t)requestId { (void)requestId; }
- (void)pingWithReply:(void (^)(void))reply { if (reply) reply(); }
- (void)event:(uint64_t)event eventData:(id)data { (void)event; (void)data; }
- (void)internalEvent:(uint64_t)event internalEventData:(id)data { (void)event; (void)data; }
@end

@interface BerdSiriSynthesisSession : NSObject
@property(nonatomic, strong) NSXPCConnection *connection;
@property(nonatomic, strong) BerdSiriSessionDelegateImpl *delegate;
@property(nonatomic, strong) id request;
@property(nonatomic, copy) void (^completion)(NSError *_Nullable error);
@property(nonatomic, assign) BOOL finished;
- (instancetype)initWithAudioHandler:(BerdAudioHandler)audioHandler;
- (void)synthesizeText:(NSString *)text language:(NSString *)language
             voiceName:(NSString *)voiceName rate:(float)rate
            completion:(void (^)(NSError *_Nullable error))completion;
- (void)cancel;
@end

@implementation BerdSiriSynthesisSession
- (instancetype)initWithAudioHandler:(BerdAudioHandler)audioHandler {
    self = [super init];
    if (self) {
        _delegate = [BerdSiriSessionDelegateImpl new];
        _delegate.audioHandler = audioHandler;
    }
    return self;
}
- (void)finish:(NSError *)error {
    void (^completion)(NSError *) = nil;
    @synchronized (self) {
        if (self.finished) return;
        self.finished = YES;
        completion = self.completion;
        self.completion = nil;
    }
    if (completion) completion(error);
}
- (void)synthesizeText:(NSString *)text language:(NSString *)language
             voiceName:(NSString *)voiceName rate:(float)rate
            completion:(void (^)(NSError *))completion {
    NSError *error = nil;
    id voice = BerdCreateVoice(language, voiceName, &error);
    if (!voice) {
        completion(error ?: BerdError(12, @"Could not create Siri voice."));
        return;
    }
    Class requestClass = objc_getClass("SiriTTSSynthesisRequest");
    SEL selector = @selector(initWithText:voice:);
    if (!requestClass || ![requestClass instancesRespondToSelector:selector]) {
        completion(BerdError(13, @"Siri synthesis requests are unavailable."));
        return;
    }
    typedef id (*InitializeRequest)(id, SEL, id, id);
    id request = ((InitializeRequest)objc_msgSend)([requestClass alloc], selector, text, voice);
    if (rate != 1.0f && [request respondsToSelector:@selector(setRate:)]) {
        ((void (*)(id, SEL, float))objc_msgSend)(request, @selector(setRate:), rate);
    }

    NSXPCConnection *connection = [[NSXPCConnection alloc]
        initWithMachServiceName:@"com.apple.sirittsd" options:0];
    NSXPCInterface *remote = [NSXPCInterface
        interfaceWithProtocol:@protocol(BerdSiriTTSDaemonProtocol)];
    [remote setClasses:BerdRequestClasses()
            forSelector:@selector(synthesizeWithRequest:reply:)
          argumentIndex:0
                ofReply:NO];
    [remote setClasses:BerdRequestClasses()
            forSelector:@selector(cancelWithRequest:)
          argumentIndex:0
                ofReply:NO];
    connection.remoteObjectInterface = remote;
    NSXPCInterface *exported = [NSXPCInterface
        interfaceWithProtocol:@protocol(BerdSiriTTSSessionDelegate)];
    NSSet<Class> *callbackClasses = BerdCallbackClasses();
    [exported setClasses:callbackClasses
             forSelector:@selector(didGenerateAudioWithRequestId:audio:)
           argumentIndex:1
                 ofReply:NO];
    [exported setClasses:callbackClasses
             forSelector:@selector(didGenerateWordTimingsWithRequestId:wordTimingInfo:)
           argumentIndex:1
                 ofReply:NO];
    [exported setClasses:callbackClasses
             forSelector:@selector(didReportInstrumentWithRequestId:instrumentationMetrics:)
           argumentIndex:1
                 ofReply:NO];
    connection.exportedInterface = exported;
    connection.exportedObject = self.delegate;

    self.request = request;
    self.connection = connection;
    self.completion = completion;
    self.finished = NO;
    __weak typeof(self) weakSelf = self;
    connection.interruptionHandler = ^{
        [weakSelf finish:BerdError(14, @"Siri synthesis connection was interrupted.")];
    };
    connection.invalidationHandler = ^{
        [weakSelf finish:BerdError(15, @"Siri synthesis connection was invalidated.")];
    };
    [connection resume];
    id<BerdSiriTTSDaemonProtocol> proxy =
        [connection remoteObjectProxyWithErrorHandler:^(NSError *proxyError) {
            [weakSelf finish:proxyError];
        }];
    [proxy synthesizeWithRequest:request reply:^(NSError *replyError) {
        [weakSelf finish:replyError];
    }];
}
- (void)cancel {
    if (self.connection && self.request) {
        id<BerdSiriTTSDaemonProtocol> proxy =
            [self.connection remoteObjectProxyWithErrorHandler:^(__unused NSError *error) {}];
        [proxy cancelWithRequest:self.request];
    }
    [self finish:BerdError(NSUserCancelledError, @"Siri synthesis cancelled.")];
    [self.connection invalidate];
    self.connection = nil;
    self.request = nil;
}
- (void)dealloc { [self.connection invalidate]; }
@end

@interface BerdSiriDeliverySegment : NSObject
@property(nonatomic, copy) NSString *text;
@property(nonatomic, assign) uint64_t totalFrames;
@property(nonatomic, assign) BOOL synthesisComplete;
@end

@implementation BerdSiriDeliverySegment
@end

@interface BerdSiriSpeechPlayer : NSObject
@property(nonatomic, strong) dispatch_queue_t queue;
@property(nonatomic, strong) AVAudioEngine *engine;
@property(nonatomic, strong) AVAudioPlayerNode *player;
@property(nonatomic, strong) AVAudioConverter *converter;
@property(nonatomic, strong) BerdSiriSynthesisSession *session;
@property(nonatomic, strong) NSMutableArray<BerdSiriDeliverySegment *> *pendingTexts;
@property(nonatomic, strong) NSMutableArray<BerdSiriDeliverySegment *> *deliverySegments;
@property(nonatomic, strong) dispatch_semaphore_t completionSemaphore;
@property(nonatomic, strong) NSError *error;
@property(nonatomic, assign) NSInteger pendingBuffers;
@property(nonatomic, assign) BOOL inputFinished;
@property(nonatomic, assign) BOOL playbackStarted;
@property(nonatomic, assign) BOOL finished;
@property(nonatomic, assign) uint64_t progressGeneration;
@property(nonatomic, assign) double playbackSampleRate;
@property(nonatomic, assign) BerdSiriTTSPlaybackStarted startedCallback;
@property(nonatomic, assign) void *callbackContext;
@property(nonatomic, copy) NSString *language;
@property(nonatomic, copy) NSString *voiceName;
@property(nonatomic, assign) float rate;
- (void)enqueueText:(NSString *)text;
- (void)finishInput;
- (void)cancel;
- (NSString *)deliveryJSON;
@end

@implementation BerdSiriSpeechPlayer
- (instancetype)init {
    self = [super init];
    if (self) {
        _queue = dispatch_queue_create("com.block.berd.sirittsd", DISPATCH_QUEUE_SERIAL);
        dispatch_queue_set_specific(_queue, BerdSiriSpeechQueueKey,
                                    BerdSiriSpeechQueueKey, NULL);
        _completionSemaphore = dispatch_semaphore_create(0);
        _pendingTexts = [NSMutableArray array];
        _deliverySegments = [NSMutableArray array];
    }
    return self;
}
- (void)finish:(NSError *)error {
    if (self.finished) return;
    self.finished = YES;
    self.error = error;
    self.progressGeneration += 1;
    dispatch_semaphore_signal(self.completionSemaphore);
}
- (void)finishIfReady {
    if (self.inputFinished && !self.session && self.pendingTexts.count == 0 &&
        self.pendingBuffers == 0) {
        [self finish:self.error];
    }
}
- (AVAudioPCMBuffer *)decodeData:(NSData *)data
                          format:(AudioStreamBasicDescription)description
                     packetCount:(UInt32)packetCount
              packetDescriptions:(NSData *)packetDescriptions
                           error:(NSError **)error {
    if (description.mFormatID == kAudioFormatLinearPCM) {
        if (description.mBytesPerFrame == 0) {
            if (error) *error = BerdError(16, @"Siri returned an invalid PCM format.");
            return nil;
        }
        AVAudioFormat *format = [[AVAudioFormat alloc] initWithStreamDescription:&description];
        AVAudioFrameCount count = (AVAudioFrameCount)(data.length / description.mBytesPerFrame);
        AVAudioPCMBuffer *buffer = [[AVAudioPCMBuffer alloc]
            initWithPCMFormat:format frameCapacity:count];
        buffer.frameLength = count;
        AudioBuffer *destination = &buffer.mutableAudioBufferList->mBuffers[0];
        memcpy(destination->mData, data.bytes, MIN(data.length, destination->mDataByteSize));
        return buffer;
    }
    if (description.mFormatID != kAudioFormatOpus) {
        if (error) *error = BerdError(17, @"Siri returned an unsupported audio format.");
        return nil;
    }
    AVAudioFormat *source = [[AVAudioFormat alloc] initWithStreamDescription:&description];
    AVAudioFormat *destination = [[AVAudioFormat alloc]
        initWithCommonFormat:AVAudioPCMFormatFloat32
                  sampleRate:description.mSampleRate
                    channels:description.mChannelsPerFrame
                 interleaved:NO];
    if (!self.converter) self.converter = [[AVAudioConverter alloc] initFromFormat:source
                                                                         toFormat:destination];
    UInt32 count = MAX(packetCount, 1);
    AVAudioCompressedBuffer *compressed = [[AVAudioCompressedBuffer alloc]
        initWithFormat:source packetCapacity:count maximumPacketSize:MAX((UInt32)data.length, 1)];
    compressed.byteLength = (UInt32)data.length;
    compressed.packetCount = count;
    memcpy(compressed.data, data.bytes, data.length);
    if (packetDescriptions.length >= count * sizeof(AudioStreamPacketDescription)) {
        memcpy(compressed.packetDescriptions, packetDescriptions.bytes,
               count * sizeof(AudioStreamPacketDescription));
    } else if (count == 1) {
        compressed.packetDescriptions[0] = (AudioStreamPacketDescription){
            .mStartOffset = 0, .mVariableFramesInPacket = 0,
            .mDataByteSize = (UInt32)data.length,
        };
    } else {
        if (error) *error = BerdError(18, @"Siri omitted Opus packet descriptions.");
        return nil;
    }
    AVAudioPCMBuffer *pcm = [[AVAudioPCMBuffer alloc]
        initWithPCMFormat:destination frameCapacity:count * 5760];
    __block BOOL supplied = NO;
    NSError *conversionError = nil;
    AVAudioConverterOutputStatus status = [self.converter
        convertToBuffer:pcm error:&conversionError
        withInputFromBlock:^AVAudioBuffer *(AVAudioPacketCount requested,
                                             AVAudioConverterInputStatus *inputStatus) {
            (void)requested;
            if (supplied) {
                *inputStatus = AVAudioConverterInputStatus_NoDataNow;
                return nil;
            }
            supplied = YES;
            *inputStatus = AVAudioConverterInputStatus_HaveData;
            return compressed;
        }];
    if (conversionError || status == AVAudioConverterOutputStatus_Error) {
        if (error) *error = conversionError ?: BerdError(19, @"Could not decode Siri audio.");
        return nil;
    }
    return pcm.frameLength ? pcm : nil;
}
- (BOOL)ensurePlayer:(AVAudioFormat *)format error:(NSError **)error {
    if (self.player) return YES;
    self.engine = [AVAudioEngine new];
    self.player = [AVAudioPlayerNode new];
    [self.engine attachNode:self.player];
    [self.engine connect:self.player to:self.engine.mainMixerNode format:format];
    [self.engine prepare];
    if (![self.engine startAndReturnError:error]) return NO;
    return YES;
}
- (void)enqueueData:(NSData *)data format:(AudioStreamBasicDescription)format
         packetCount:(UInt32)packetCount packetDescriptions:(NSData *)packetDescriptions
         deliverySegment:(BerdSiriDeliverySegment *)deliverySegment {
    if (self.finished || !data.length) return;
    self.progressGeneration += 1;
    NSError *error = nil;
    AVAudioPCMBuffer *buffer = [self decodeData:data format:format packetCount:packetCount
                            packetDescriptions:packetDescriptions error:&error];
    if (error || !buffer) {
        if (error) [self finish:error];
        return;
    }
    if (![self ensurePlayer:buffer.format error:&error]) {
        [self finish:error];
        return;
    }
    if (self.playbackSampleRate == 0) {
        self.playbackSampleRate = buffer.format.sampleRate;
    }
    deliverySegment.totalFrames += buffer.frameLength;
    self.pendingBuffers += 1;
    [self.player scheduleBuffer:buffer completionCallbackType:AVAudioPlayerNodeCompletionDataPlayedBack
               completionHandler:^(__unused AVAudioPlayerNodeCompletionCallbackType type) {
        dispatch_async(self.queue, ^{
            self.pendingBuffers = MAX(0, self.pendingBuffers - 1);
            self.progressGeneration += 1;
            [self finishIfReady];
        });
    }];
    if (!self.playbackStarted) {
        self.playbackStarted = YES;
        [self.player play];
        if (self.startedCallback) self.startedCallback(self.callbackContext);
    }
}
- (void)startNextSynthesis {
    if (self.finished || self.session || self.pendingTexts.count == 0) {
        [self finishIfReady];
        return;
    }
    BerdSiriDeliverySegment *deliverySegment = self.pendingTexts.firstObject;
    NSString *text = deliverySegment.text;
    [self.pendingTexts removeObjectAtIndex:0];
    self.progressGeneration += 1;
    __weak typeof(self) weakSelf = self;
    self.session = [[BerdSiriSynthesisSession alloc]
        initWithAudioHandler:^(NSData *data, AudioStreamBasicDescription format,
                               UInt32 packetCount, NSData *descriptions) {
            dispatch_async(weakSelf.queue, ^{
                [weakSelf enqueueData:data format:format packetCount:packetCount
                   packetDescriptions:descriptions deliverySegment:deliverySegment];
            });
        }];
    [self.session synthesizeText:text language:self.language voiceName:self.voiceName rate:self.rate
                      completion:^(NSError *error) {
        dispatch_async(weakSelf.queue, ^{
            weakSelf.progressGeneration += 1;
            weakSelf.session = nil;
            if (error && error.code != NSUserCancelledError) {
                [weakSelf finish:error];
                return;
            }
            if (!error) deliverySegment.synthesisComplete = YES;
            [weakSelf startNextSynthesis];
        });
    }];
}
- (void)enqueueText:(NSString *)text {
    dispatch_async(self.queue, ^{
        if (self.finished || self.inputFinished || !text.length) return;
        BerdSiriDeliverySegment *segment = [BerdSiriDeliverySegment new];
        segment.text = text;
        [self.pendingTexts addObject:segment];
        [self.deliverySegments addObject:segment];
        self.progressGeneration += 1;
        [self startNextSynthesis];
    });
}
- (void)finishInput {
    dispatch_async(self.queue, ^{
        self.inputFinished = YES;
        self.progressGeneration += 1;
        [self startNextSynthesis];
        [self finishIfReady];
    });
}
- (NSString *)deliveryJSON {
    __block NSString *json = @"{\"sampleRate\":0,\"segments\":[]}";
    void (^snapshot)(void) = ^{
        uint64_t playedFrames = 0;
        if (self.player && self.player.lastRenderTime) {
            AVAudioTime *playerTime = [self.player playerTimeForNodeTime:self.player.lastRenderTime];
            if (playerTime && playerTime.sampleTime > 0) {
                playedFrames = (uint64_t)playerTime.sampleTime;
            }
        }
        uint64_t latencyFrames = self.playbackSampleRate > 0
            ? (uint64_t)llround(self.playbackSampleRate * 0.1)
            : 0;
        playedFrames = playedFrames > latencyFrames ? playedFrames - latencyFrames : 0;
        uint64_t segmentStart = 0;
        NSMutableArray<NSDictionary<NSString *, id> *> *segments = [NSMutableArray array];
        for (BerdSiriDeliverySegment *segment in self.deliverySegments) {
            uint64_t played = playedFrames > segmentStart
                ? MIN(segment.totalFrames, playedFrames - segmentStart)
                : 0;
            [segments addObject:@{
                @"text": segment.text ?: @"",
                @"playedFrames": @(played),
                @"totalFrames": @(segment.totalFrames),
                @"synthesisComplete": @(segment.synthesisComplete),
            }];
            segmentStart += segment.totalFrames;
        }
        NSData *data = [NSJSONSerialization dataWithJSONObject:@{
            @"sampleRate": @((uint32_t)llround(self.playbackSampleRate)),
            @"segments": segments,
        }
                                                       options:0 error:nil];
        if (data) json = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    };
    if (dispatch_get_specific(BerdSiriSpeechQueueKey)) snapshot();
    else dispatch_sync(self.queue, snapshot);
    return json;
}
- (void)cancel {
    void (^cancelWork)(void) = ^{
        if (self.finished) return;
        self.startedCallback = NULL;
        self.callbackContext = NULL;
        [self.session cancel];
        [self.player stop];
        [self.engine stop];
        [self finish:BerdError(NSUserCancelledError, @"Siri playback cancelled.")];
    };
    if (dispatch_get_specific(BerdSiriSpeechQueueKey)) cancelWork();
    else dispatch_sync(self.queue, cancelWork);
}
@end

static void BerdDownloadedVoices(
    NSString *language,
    NSString *voiceName,
    void (^completion)(NSArray<NSDictionary<NSString *, id> *> *, NSError *)
) {
    NSError *error = nil;
    id voice = BerdCreateVoice(language, voiceName, &error);
    if (!voice) {
        completion(nil, error ?: BerdError(3, @"Could not create Siri voice query."));
        return;
    }

    NSXPCConnection *connection = [[NSXPCConnection alloc]
        initWithMachServiceName:@"com.apple.sirittsd" options:0];
    NSXPCInterface *interface = [NSXPCInterface
        interfaceWithProtocol:@protocol(BerdSiriTTSAvailabilityProtocol)];
    NSSet<Class> *classes = BerdRequestClasses();
    [interface setClasses:classes
              forSelector:@selector(downloadedVoicesMatching:reply:)
            argumentIndex:0
                  ofReply:NO];
    [interface setClasses:classes
              forSelector:@selector(downloadedVoicesMatching:reply:)
            argumentIndex:0
                  ofReply:YES];
    connection.remoteObjectInterface = interface;

    __block BOOL replied = NO;
    void (^finish)(NSArray *, NSError *) = ^(NSArray *voices, NSError *finishError) {
        @synchronized (connection) {
            if (replied) return;
            replied = YES;
        }
        NSMutableArray *result = [NSMutableArray arrayWithCapacity:voices.count];
        for (id resolved in voices ?: @[]) [result addObject:BerdVoiceDictionary(resolved)];
        completion(result, finishError);
        [connection invalidate];
    };
    connection.invalidationHandler = ^{
        finish(nil, BerdError(4, @"Siri voice query connection was invalidated."));
    };
    [connection resume];
    id<BerdSiriTTSAvailabilityProtocol> proxy =
        [connection remoteObjectProxyWithErrorHandler:^(NSError *proxyError) {
            finish(nil, proxyError);
        }];
    [proxy downloadedVoicesMatching:voice reply:^(NSArray *voices) {
        finish(voices, nil);
    }];
    dispatch_after(
        dispatch_time(DISPATCH_TIME_NOW, (int64_t)(3 * NSEC_PER_SEC)),
        dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0),
        ^{ finish(nil, BerdError(5, @"Timed out validating Siri voice.")); }
    );
}

static NSDictionary<NSString *, id> *BerdDownloadedVoiceSync(
    NSString *language,
    NSString *voiceName,
    NSError **error
) {
    dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
    __block NSArray<NSDictionary<NSString *, id> *> *voices = nil;
    __block NSError *replyError = nil;
    BerdDownloadedVoices(language, voiceName, ^(NSArray *reply, NSError *failure) {
        voices = reply;
        replyError = failure;
        dispatch_semaphore_signal(semaphore);
    });
    dispatch_semaphore_wait(
        semaphore,
        dispatch_time(DISPATCH_TIME_NOW, (int64_t)(4 * NSEC_PER_SEC))
    );
    if (replyError) {
        if (error) *error = replyError;
        return nil;
    }
    NSString *normalizedLanguage =
        [[language stringByReplacingOccurrencesOfString:@"_" withString:@"-"] lowercaseString];
    for (NSDictionary *candidate in voices ?: @[]) {
        NSString *candidateName = candidate[@"name"];
        NSString *candidateLanguage = candidate[@"language"];
        NSString *normalizedCandidate =
            [[candidateLanguage stringByReplacingOccurrencesOfString:@"_" withString:@"-"] lowercaseString];
        if ([candidateName caseInsensitiveCompare:voiceName] == NSOrderedSame &&
            [normalizedCandidate isEqualToString:normalizedLanguage]) {
            return candidate;
        }
    }
    return nil;
}

static NSArray<NSDictionary<NSString *, id> *> *BerdDiscoverVoices(
    NSString *languagePrefix,
    NSError **error
) {
    if (!BerdLoadFramework(
        @"/System/Library/PrivateFrameworks/TextToSpeech.framework/TextToSpeech",
        error
    )) return nil;
    Class managerClass = objc_getClass("TTSAXResourceManager");
    if (!managerClass) {
        if (error) *error = BerdError(6, @"Siri voice catalog is unavailable.");
        return nil;
    }
    SEL sharedSelector = @selector(sharedInstance);
    SEL voicesSelector = @selector(allVoices:);
    if (![managerClass respondsToSelector:sharedSelector]) {
        if (error) *error = BerdError(6, @"Siri voice catalog manager is unavailable.");
        return nil;
    }
    typedef id (*SendNoArguments)(id, SEL);
    typedef id (*SendObject)(id, SEL, id);
    id manager = ((SendNoArguments)objc_msgSend)(managerClass, sharedSelector);
    if (![manager respondsToSelector:voicesSelector]) {
        if (error) *error = BerdError(6, @"Siri voice catalog lookup is unavailable.");
        return nil;
    }
    NSArray *resources = ((SendObject)objc_msgSend)(manager, voicesSelector, nil);
    NSString *normalizedPrefix =
        [[languagePrefix stringByReplacingOccurrencesOfString:@"_" withString:@"-"] lowercaseString];
    NSMutableDictionary<NSString *, NSDictionary<NSString *, id> *> *byKey =
        [NSMutableDictionary dictionary];
    for (id resource in resources ?: @[]) {
        NSString *identifier = [resource valueForKey:@"identifier"];
        if (![identifier hasPrefix:@"com.apple.siri.natural."]) continue;
        NSString *language = [resource valueForKey:@"language"] ?: @"";
        NSString *normalizedLanguage =
            [[language stringByReplacingOccurrencesOfString:@"_" withString:@"-"] lowercaseString];
        if (normalizedPrefix.length && ![normalizedLanguage isEqualToString:normalizedPrefix]) continue;
        NSString *name = [resource valueForKey:@"name"] ?: @"";
        if (!name.length || !language.length) continue;
        NSString *key = [NSString stringWithFormat:@"%@|%@", name.lowercaseString,
                                                   normalizedLanguage];
        byKey[key] = @{
            @"name" : name,
            @"language" : language,
            @"sizeBytes" : [resource valueForKey:@"assetSize"] ?: @0,
        };
    }
    return [[byKey allValues] sortedArrayUsingComparator:
        ^NSComparisonResult(NSDictionary *left, NSDictionary *right) {
            NSComparisonResult language = [left[@"language"]
                localizedCaseInsensitiveCompare:right[@"language"]];
            return language != NSOrderedSame
                ? language
                : [left[@"name"] localizedCaseInsensitiveCompare:right[@"name"]];
        }];
}

static BOOL BerdSubscribeVoiceSync(NSString *language, NSString *voiceName, NSError **error) {
    NSError *voiceError = nil;
    id voice = BerdCreateVoice(language, voiceName, &voiceError);
    if (!voice) {
        if (error) *error = voiceError;
        return NO;
    }
    NSXPCConnection *connection = [[NSXPCConnection alloc]
        initWithMachServiceName:@"com.apple.sirittsd" options:0];
    NSXPCInterface *interface = [NSXPCInterface
        interfaceWithProtocol:@protocol(BerdSiriTTSSubscribeProtocol)];
    [interface setClasses:BerdRequestClasses()
              forSelector:@selector(subscribeWithVoices:clientId:accessoryId:reply:)
            argumentIndex:0
                  ofReply:NO];
    connection.remoteObjectInterface = interface;
    dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
    __block NSError *replyError = nil;
    __block BOOL replied = NO;
    void (^finish)(NSError *) = ^(NSError *failure) {
        @synchronized (connection) {
            if (replied) return;
            replyError = failure;
            replied = YES;
        }
        dispatch_semaphore_signal(semaphore);
        [connection invalidate];
    };
    [connection resume];
    id<BerdSiriTTSSubscribeProtocol> proxy =
        [connection remoteObjectProxyWithErrorHandler:^(NSError *proxyError) {
            finish(proxyError);
        }];
    [proxy subscribeWithVoices:@[ voice ]
                     clientId:@"com.apple.speech"
                  accessoryId:@""
                        reply:^(NSError *failure) { finish(failure); }];
    long wait = dispatch_semaphore_wait(
        semaphore,
        dispatch_time(DISPATCH_TIME_NOW, (int64_t)(10 * NSEC_PER_SEC))
    );
    if (wait != 0) finish(BerdError(7, @"Timed out subscribing to Siri voice."));
    if (replyError) {
        if (error) *error = replyError;
        return NO;
    }
    return YES;
}

static BOOL BerdTriggerDownload(NSString *language, NSError **error) {
    if (!BerdLoadFramework(
        @"/System/Library/PrivateFrameworks/UnifiedAssetFramework.framework/UnifiedAssetFramework",
        error
    )) return NO;
    Class serviceClass = objc_getClass("UAFAssetUtilitiesService");
    if (!serviceClass) {
        if (error) *error = BerdError(8, @"Siri voice download service is unavailable.");
        return NO;
    }
    id service = [serviceClass new];
    SEL switchSelector = NSSelectorFromString(@"switchLanguage:");
    SEL downloadSelector = NSSelectorFromString(@"downloadSiriAssets");
    if (![service respondsToSelector:switchSelector] ||
        ![service respondsToSelector:downloadSelector]) {
        if (error) *error = BerdError(9, @"Siri voice download API is unavailable.");
        return NO;
    }
    NSString *normalized = [language stringByReplacingOccurrencesOfString:@"-" withString:@"_"];
    ((void (*)(id, SEL, id))objc_msgSend)(service, switchSelector, normalized);
    ((void (*)(id, SEL))objc_msgSend)(service, downloadSelector);
    return YES;
}

char *berd_siri_tts_catalog_json(const char *languagePrefix, char **errorOut) {
    @autoreleasepool {
        if (errorOut) *errorOut = NULL;
        NSString *prefix = languagePrefix
            ? [NSString stringWithUTF8String:languagePrefix]
            : @"";
        NSError *error = nil;
        NSArray<NSDictionary<NSString *, id> *> *candidates =
            BerdDiscoverVoices(prefix, &error);
        if (!candidates) {
            BerdSetError(errorOut, error);
            return NULL;
        }

        dispatch_group_t group = dispatch_group_create();
        NSMutableDictionary<NSString *, NSNumber *> *installed = [NSMutableDictionary dictionary];
        for (NSDictionary *candidate in candidates) {
            NSString *name = candidate[@"name"];
            NSString *language = candidate[@"language"];
            NSString *key = [NSString stringWithFormat:@"%@|%@", name.lowercaseString,
                                                       language.lowercaseString];
            dispatch_group_enter(group);
            BerdDownloadedVoices(language, name, ^(NSArray *voices, NSError *failure) {
                BOOL exact = NO;
                if (!failure) {
                    for (NSDictionary *voice in voices) {
                        if ([voice[@"name"] caseInsensitiveCompare:name] == NSOrderedSame &&
                            [voice[@"language"] caseInsensitiveCompare:language] == NSOrderedSame) {
                            exact = YES;
                            break;
                        }
                    }
                }
                @synchronized (installed) { installed[key] = @(exact); }
                dispatch_group_leave(group);
            });
        }
        dispatch_group_wait(
            group,
            dispatch_time(DISPATCH_TIME_NOW, (int64_t)(4 * NSEC_PER_SEC))
        );

        NSMutableArray *result = [NSMutableArray arrayWithCapacity:candidates.count];
        for (NSDictionary *candidate in candidates) {
            NSString *key = [NSString stringWithFormat:@"%@|%@",
                [candidate[@"name"] lowercaseString],
                [candidate[@"language"] lowercaseString]];
            NSMutableDictionary *voice = [candidate mutableCopy];
            voice[@"installed"] = installed[key] ?: @NO;
            [result addObject:voice];
        }
        NSData *json = [NSJSONSerialization dataWithJSONObject:result options:0 error:&error];
        if (!json) {
            BerdSetError(errorOut, error);
            return NULL;
        }
        NSString *encoded = [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
        return strdup(encoded.UTF8String);
    }
}

char *berd_siri_tts_languages_json(char **errorOut) {
    @autoreleasepool {
        if (errorOut) *errorOut = NULL;
        NSError *error = nil;
        NSArray<NSDictionary<NSString *, id> *> *candidates =
            BerdDiscoverVoices(@"", &error);
        if (!candidates) {
            BerdSetError(errorOut, error);
            return NULL;
        }
        NSMutableSet<NSString *> *languages = [NSMutableSet set];
        for (NSDictionary *candidate in candidates) {
            NSString *language = candidate[@"language"];
            if (language.length) [languages addObject:language];
        }
        NSArray *sorted = [[languages allObjects]
            sortedArrayUsingSelector:@selector(localizedCaseInsensitiveCompare:)];
        NSData *json = [NSJSONSerialization dataWithJSONObject:sorted options:0 error:&error];
        if (!json) {
            BerdSetError(errorOut, error);
            return NULL;
        }
        NSString *encoded = [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
        return strdup(encoded.UTF8String);
    }
}

bool berd_siri_tts_download_voice(
    const char *languageValue,
    const char *voiceNameValue,
    double timeoutSeconds,
    char **errorOut
) {
    @autoreleasepool {
        if (errorOut) *errorOut = NULL;
        if (!languageValue || !voiceNameValue) {
            BerdSetError(errorOut, BerdError(10, @"A Siri voice name and language are required."));
            return false;
        }
        NSString *language = [NSString stringWithUTF8String:languageValue];
        NSString *voiceName = [NSString stringWithUTF8String:voiceNameValue];
        NSError *error = nil;
        if (BerdDownloadedVoiceSync(language, voiceName, &error)) return true;
        error = nil;
        if (!BerdSubscribeVoiceSync(language, voiceName, &error) ||
            !BerdTriggerDownload(language, &error)) {
            BerdSetError(errorOut, error);
            return false;
        }

        NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:MAX(1, timeoutSeconds)];
        while ([deadline timeIntervalSinceNow] > 0) {
            error = nil;
            if (BerdDownloadedVoiceSync(language, voiceName, &error)) return true;
            [NSThread sleepForTimeInterval:2];
        }
        BerdSetError(errorOut, BerdError(11,
            [NSString stringWithFormat:@"Timed out downloading %@ (%@).", voiceName, language]));
        return false;
    }
}

static NSURL *BerdSiriVoiceSampleURL(NSString *voiceName, NSString *language) {
    NSURL *root = [NSURL fileURLWithPath:
        @"/System/Library/AssetsV2/com_apple_MobileAsset_TTSAXResourceModelAssets"
        isDirectory:YES];
    NSArray<NSURL *> *assets = [[NSFileManager defaultManager]
        contentsOfDirectoryAtURL:root
      includingPropertiesForKeys:nil
                         options:NSDirectoryEnumerationSkipsHiddenFiles
                           error:nil];
    NSString *normalizedName = voiceName.lowercaseString;
    NSString *normalizedLanguage =
        [[language stringByReplacingOccurrencesOfString:@"_" withString:@"-"] lowercaseString];
    NSString *suffix = [NSString stringWithFormat:@"_%@_%@_premium.caf",
                                                  normalizedName,
                                                  normalizedLanguage];
    NSMutableArray<NSURL *> *matches = [NSMutableArray array];
    for (NSURL *asset in assets ?: @[]) {
        NSURL *contents = [[asset URLByAppendingPathComponent:@"AssetData" isDirectory:YES]
            URLByAppendingPathComponent:@"Contents" isDirectory:YES];
        NSArray<NSURL *> *samples = [[NSFileManager defaultManager]
            contentsOfDirectoryAtURL:contents
          includingPropertiesForKeys:nil
                             options:NSDirectoryEnumerationSkipsHiddenFiles
                               error:nil];
        for (NSURL *sample in samples ?: @[]) {
            if ([sample.lastPathComponent.lowercaseString hasSuffix:suffix]) {
                [matches addObject:sample];
            }
        }
    }
    [matches sortUsingComparator:^NSComparisonResult(NSURL *left, NSURL *right) {
        NSInteger (^rank)(NSURL *) = ^NSInteger(NSURL *url) {
            NSString *name = url.lastPathComponent.lowercaseString;
            if ([name containsString:@"gryphon-neuralax_"]) return 0;
            if ([name containsString:@"gryphon-neural_"]) return 1;
            return 2;
        };
        NSInteger leftRank = rank(left);
        NSInteger rightRank = rank(right);
        if (leftRank != rightRank) {
            return leftRank < rightRank ? NSOrderedAscending : NSOrderedDescending;
        }
        return [left.lastPathComponent localizedCaseInsensitiveCompare:right.lastPathComponent];
    }];
    return matches.firstObject;
}

bool berd_siri_tts_play_sample(
    const char *voiceNameValue,
    const char *languageValue,
    float rate,
    BerdSiriTTSShouldStop shouldStop,
    void *context,
    char **errorOut
) {
    @autoreleasepool {
        if (errorOut) *errorOut = NULL;
        if (!voiceNameValue || !languageValue) {
            BerdSetError(errorOut,
                         BerdError(23, @"A Siri voice name and language are required."));
            return false;
        }
        NSString *voiceName = [NSString stringWithUTF8String:voiceNameValue];
        NSString *language = [NSString stringWithUTF8String:languageValue];
        NSURL *sampleURL = BerdSiriVoiceSampleURL(voiceName, language);
        if (!sampleURL) {
            BerdSetError(errorOut, BerdError(24,
                [NSString stringWithFormat:@"No system preview is available for %@ (%@).",
                                           voiceName, language]));
            return false;
        }
        NSError *error = nil;
        AVAudioPlayer *player = [[AVAudioPlayer alloc]
            initWithContentsOfURL:sampleURL error:&error];
        if (!player) {
            BerdSetError(errorOut,
                         error ?: BerdError(25, @"Could not open the Siri voice preview."));
            return false;
        }
        player.enableRate = YES;
        player.rate = MAX(0.5f, MIN(2.0f, rate));
        if (![player prepareToPlay] || ![player play]) {
            BerdSetError(errorOut, BerdError(26, @"Could not play the Siri voice preview."));
            return false;
        }
        while (player.isPlaying) {
            if (shouldStop && shouldStop(context)) {
                [player stop];
                return true;
            }
            [NSThread sleepForTimeInterval:0.01];
        }
        return true;
    }
}

void *berd_siri_tts_stream_create(
    const char *languageValue,
    const char *voiceNameValue,
    float rate,
    BerdSiriTTSPlaybackStarted playbackStarted,
    void *context,
    char **errorOut
) {
    @autoreleasepool {
        if (errorOut) *errorOut = NULL;
        if (!languageValue || !voiceNameValue) {
            BerdSetError(errorOut, BerdError(20, @"A Siri voice name and language are required."));
            return NULL;
        }
        NSString *language = [NSString stringWithUTF8String:languageValue];
        NSString *voiceName = [NSString stringWithUTF8String:voiceNameValue];
        NSError *validationError = nil;
        if (!BerdDownloadedVoiceSync(language, voiceName, &validationError)) {
            BerdSetError(errorOut, validationError ?: BerdError(21,
                [NSString stringWithFormat:@"Siri voice %@ (%@) is not installed.",
                                           voiceName, language]));
            return NULL;
        }
        BerdSiriSpeechPlayer *player = [BerdSiriSpeechPlayer new];
        player.language = language;
        player.voiceName = voiceName;
        player.rate = MAX(0.25f, MIN(4.0f, rate));
        player.startedCallback = playbackStarted;
        player.callbackContext = context;
        return (__bridge_retained void *)player;
    }
}

bool berd_siri_tts_stream_enqueue(void *stream, const char *textValue, char **errorOut) {
    @autoreleasepool {
        if (errorOut) *errorOut = NULL;
        if (!stream || !textValue) {
            BerdSetError(errorOut, BerdError(22, @"An active Siri stream and text are required."));
            return false;
        }
        BerdSiriSpeechPlayer *player = (__bridge BerdSiriSpeechPlayer *)stream;
        NSString *text = [NSString stringWithUTF8String:textValue];
        if (!text.length) return true;
        [player enqueueText:text];
        return true;
    }
}

void berd_siri_tts_stream_finish(void *stream) {
    if (!stream) return;
    [(__bridge BerdSiriSpeechPlayer *)stream finishInput];
}

bool berd_siri_tts_stream_is_finished(void *stream) {
    if (!stream) return true;
    BerdSiriSpeechPlayer *player = (__bridge BerdSiriSpeechPlayer *)stream;
    __block BOOL finished = NO;
    dispatch_sync(player.queue, ^{ finished = player.finished; });
    return finished;
}

uint64_t berd_siri_tts_stream_progress(void *stream) {
    if (!stream) return 0;
    BerdSiriSpeechPlayer *player = (__bridge BerdSiriSpeechPlayer *)stream;
    __block uint64_t progress = 0;
    dispatch_sync(player.queue, ^{ progress = player.progressGeneration; });
    return progress;
}

char *berd_siri_tts_stream_copy_delivery_json(void *stream) {
    if (!stream) return strdup("{\"sampleRate\":0,\"segments\":[]}");
    NSString *json = [(__bridge BerdSiriSpeechPlayer *)stream deliveryJSON];
    return strdup((json ?: @"{\"sampleRate\":0,\"segments\":[]}").UTF8String);
}

char *berd_siri_tts_stream_copy_error(void *stream) {
    if (!stream) return strdup("Siri stream is unavailable");
    BerdSiriSpeechPlayer *player = (__bridge BerdSiriSpeechPlayer *)stream;
    __block NSString *message = nil;
    dispatch_sync(player.queue, ^{ message = player.error.localizedDescription; });
    return message.length ? strdup(message.UTF8String) : NULL;
}

void berd_siri_tts_stream_cancel(void *stream) {
    if (!stream) return;
    [(__bridge BerdSiriSpeechPlayer *)stream cancel];
}

void berd_siri_tts_stream_release(void *stream) {
    if (!stream) return;
    CFBridgingRelease(stream);
}

bool berd_siri_tts_speak(
    const char *textValue,
    const char *languageValue,
    const char *voiceNameValue,
    float rate,
    BerdSiriTTSShouldStop shouldStop,
    BerdSiriTTSPlaybackStarted playbackStarted,
    void *context,
    char **errorOut
) {
    @autoreleasepool {
        if (errorOut) *errorOut = NULL;
        if (!textValue || !languageValue || !voiceNameValue) {
            BerdSetError(errorOut, BerdError(20, @"Text, voice name, and language are required."));
            return false;
        }
        void *stream = berd_siri_tts_stream_create(
            languageValue, voiceNameValue, rate, playbackStarted, context, errorOut);
        if (!stream) return false;
        if (!berd_siri_tts_stream_enqueue(stream, textValue, errorOut)) {
            berd_siri_tts_stream_release(stream);
            return false;
        }
        berd_siri_tts_stream_finish(stream);
        BerdSiriSpeechPlayer *player = (__bridge BerdSiriSpeechPlayer *)stream;
        while (dispatch_semaphore_wait(
            player.completionSemaphore,
            dispatch_time(DISPATCH_TIME_NOW, (int64_t)(10 * NSEC_PER_MSEC))) != 0) {
            if (shouldStop && shouldStop(context)) berd_siri_tts_stream_cancel(stream);
        }
        char *streamError = berd_siri_tts_stream_copy_error(stream);
        berd_siri_tts_stream_release(stream);
        if (streamError) {
            if (errorOut) *errorOut = streamError;
            else free(streamError);
            return false;
        }
        return true;
    }
}

void berd_siri_tts_free_string(char *value) {
    free(value);
}
