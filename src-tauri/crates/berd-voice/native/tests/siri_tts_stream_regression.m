#import <AVFoundation/AVFoundation.h>
#import <Foundation/Foundation.h>

#import "../siri_tts_bridge.m"

@interface BerdCapturedSiriPacket : NSObject
@property(nonatomic, strong) NSData *data;
@property(nonatomic, assign) AudioStreamBasicDescription format;
@property(nonatomic, assign) UInt32 packetCount;
@property(nonatomic, strong) NSData *packetDescriptions;
@end

@implementation BerdCapturedSiriPacket
@end

static NSArray<BerdCapturedSiriPacket *> *BerdCaptureSiriPackets(
    NSString *text,
    NSString *language,
    NSString *voiceName,
    NSError **error
) {
    NSMutableArray<BerdCapturedSiriPacket *> *packets = [NSMutableArray array];
    dispatch_semaphore_t completion = dispatch_semaphore_create(0);
    __block NSError *synthesisError = nil;
    __block BerdSiriSynthesisSession *session = [[BerdSiriSynthesisSession alloc]
        initWithAudioHandler:^(NSData *data, AudioStreamBasicDescription format,
                               UInt32 packetCount, NSData *packetDescriptions) {
            BerdCapturedSiriPacket *packet = [BerdCapturedSiriPacket new];
            packet.data = [data copy];
            packet.format = format;
            packet.packetCount = packetCount;
            packet.packetDescriptions = [packetDescriptions copy];
            @synchronized (packets) { [packets addObject:packet]; }
        }];
    [session synthesizeText:text language:language voiceName:voiceName rate:1.0f
                  completion:^(NSError *failure) {
        synthesisError = failure;
        dispatch_semaphore_signal(completion);
    }];
    if (dispatch_semaphore_wait(
            completion,
            dispatch_time(DISPATCH_TIME_NOW, (int64_t)(30 * NSEC_PER_SEC))) != 0) {
        [session cancel];
        if (error) *error = BerdError(100, @"Timed out capturing Siri synthesis.");
        return nil;
    }
    session = nil;
    if (synthesisError) {
        if (error) *error = synthesisError;
        return nil;
    }
    return [packets copy];
}

static NSDictionary *BerdSelectInstalledEnglishVoice(NSError **error) {
    NSDictionary *environment = NSProcessInfo.processInfo.environment;
    NSString *configuredName = environment[@"BERD_SIRI_TEST_VOICE"];
    NSString *configuredLanguage = environment[@"BERD_SIRI_TEST_LANGUAGE"] ?: @"en-US";
    if (configuredName.length) {
        return @{ @"name": configuredName, @"language": configuredLanguage };
    }
    char *bridgeError = NULL;
    char *catalogJSON = berd_siri_tts_catalog_json(configuredLanguage.UTF8String, &bridgeError);
    if (!catalogJSON) {
        NSString *message = bridgeError
            ? [NSString stringWithUTF8String:bridgeError]
            : @"Could not read the Siri voice catalog.";
        berd_siri_tts_free_string(bridgeError);
        if (error) *error = BerdError(101, message);
        return nil;
    }
    NSData *data = [[NSData alloc] initWithBytes:catalogJSON length:strlen(catalogJSON)];
    berd_siri_tts_free_string(catalogJSON);
    NSArray *voices = [NSJSONSerialization JSONObjectWithData:data options:0 error:error];
    for (NSDictionary *voice in voices) {
        if ([voice[@"installed"] boolValue]) return voice;
    }
    if (error) {
        *error = BerdError(
            102,
            @"No installed English Siri voice is available. Set BERD_SIRI_TEST_VOICE "
             "to the voice selected in Berd."
        );
    }
    return nil;
}

static BOOL BerdDecodePackets(
    NSArray<BerdCapturedSiriPacket *> *packets,
    BerdSiriAudioDecoder *decoder,
    NSMutableData *samples,
    NSError **error
) {
    for (BerdCapturedSiriPacket *packet in packets) {
        AVAudioPCMBuffer *buffer = [decoder decodeData:packet.data
                                                format:packet.format
                                           packetCount:packet.packetCount
                                    packetDescriptions:packet.packetDescriptions
                                                 error:error];
        if (*error) return NO;
        if (!buffer) continue;
        if (samples &&
            (buffer.format.commonFormat != AVAudioPCMFormatFloat32 ||
             buffer.format.interleaved || buffer.format.channelCount != 1)) {
            if (error) *error = BerdError(103, @"Expected mono, non-interleaved Float32 PCM.");
            return NO;
        }
        if (samples) {
            [samples appendBytes:buffer.floatChannelData[0]
                          length:buffer.frameLength * sizeof(float)];
        }
    }
    return YES;
}

static BOOL BerdTestPCMNormalization(NSError **error) {
    AudioStreamBasicDescription format = {
        .mSampleRate = 48000,
        .mFormatID = kAudioFormatLinearPCM,
        .mFormatFlags = kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
        .mBytesPerPacket = sizeof(int16_t),
        .mFramesPerPacket = 1,
        .mBytesPerFrame = sizeof(int16_t),
        .mChannelsPerFrame = 1,
        .mBitsPerChannel = 16,
    };
    const int16_t sourceSamples[] = { 0, INT16_MAX, INT16_MIN, 16384, -16384 };
    NSData *data = [NSData dataWithBytes:sourceSamples length:sizeof(sourceSamples)];
    BerdSiriAudioDecoder *decoder = [BerdSiriAudioDecoder new];
    AVAudioPCMBuffer *buffer = [decoder decodeData:data
                                            format:format
                                       packetCount:5
                                packetDescriptions:[NSData data]
                                             error:error];
    if (!buffer || (error && *error)) return NO;
    if (buffer.format.commonFormat != AVAudioPCMFormatFloat32 ||
        buffer.format.interleaved || buffer.format.channelCount != 1 ||
        buffer.frameLength != 5) {
        if (error) *error = BerdError(104, @"Linear PCM was not normalized for playback.");
        return NO;
    }
    const float *samples = buffer.floatChannelData[0];
    const float expected[] = { 0.0f, 32767.0f / 32768.0f, -1.0f, 0.5f, -0.5f };
    for (NSUInteger index = 0; index < 5; index += 1) {
        if (!isfinite(samples[index]) || fabsf(samples[index] - expected[index]) > 0.0001f) {
            if (error) *error = BerdError(105, @"Linear PCM normalization changed sample values.");
            return NO;
        }
    }
    return YES;
}

typedef struct {
    NSInteger lag;
    NSUInteger unmatchedFrames;
    double correlation;
    double normalizedRMSE;
} BerdAudioComparison;

static BerdAudioComparison BerdCompareAudio(NSData *actualData, NSData *expectedData) {
    NSUInteger actualFrames = actualData.length / sizeof(float);
    NSUInteger expectedFrames = expectedData.length / sizeof(float);
    if (actualFrames == 0 || expectedFrames == 0) {
        return (BerdAudioComparison){ .normalizedRMSE = INFINITY };
    }
    const float *actual = actualData.bytes;
    const float *expected = expectedData.bytes;
    NSInteger bestLag = 0;
    double bestCorrelation = -1;
    for (NSInteger lag = -512; lag <= 512; lag += 1) {
        NSUInteger actualStart = lag > 0 ? (NSUInteger)lag : 0;
        NSUInteger expectedStart = lag < 0 ? (NSUInteger)-lag : 0;
        if (actualStart >= actualFrames || expectedStart >= expectedFrames) continue;
        NSUInteger frames = MIN(actualFrames - actualStart, expectedFrames - expectedStart);
        frames = MIN(frames, 24000);
        double crossProduct = 0;
        double actualPower = 0;
        double expectedPower = 0;
        for (NSUInteger index = 0; index < frames; index += 1) {
            double actualSample = actual[actualStart + index];
            double expectedSample = expected[expectedStart + index];
            crossProduct += actualSample * expectedSample;
            actualPower += actualSample * actualSample;
            expectedPower += expectedSample * expectedSample;
        }
        double correlation = crossProduct / sqrt(MAX(actualPower * expectedPower, DBL_MIN));
        if (correlation > bestCorrelation) {
            bestCorrelation = correlation;
            bestLag = lag;
        }
    }
    NSUInteger actualStart = bestLag > 0 ? (NSUInteger)bestLag : 0;
    NSUInteger expectedStart = bestLag < 0 ? (NSUInteger)-bestLag : 0;
    NSUInteger frames = MIN(actualFrames - actualStart, expectedFrames - expectedStart);
    NSUInteger unmatchedFrames = actualFrames + expectedFrames - (2 * frames);
    double squaredError = 0;
    double squaredSignal = 0;
    for (NSUInteger index = 0; index < frames; index += 1) {
        double difference = actual[actualStart + index] - expected[expectedStart + index];
        squaredError += difference * difference;
        squaredSignal += expected[expectedStart + index] * expected[expectedStart + index];
    }
    return (BerdAudioComparison){
        .lag = bestLag,
        .unmatchedFrames = unmatchedFrames,
        .correlation = bestCorrelation,
        .normalizedRMSE = sqrt(squaredError / MAX(squaredSignal, DBL_MIN)),
    };
}

int main(void) {
    @autoreleasepool {
        NSError *error = nil;
        if (!BerdTestPCMNormalization(&error)) {
            fprintf(stderr, "normalize PCM: %s\n", error.localizedDescription.UTF8String);
            return 1;
        }
        NSDictionary *voice = BerdSelectInstalledEnglishVoice(&error);
        if (!voice) {
            fprintf(stderr, "select Siri voice: %s\n", error.localizedDescription.UTF8String);
            return 2;
        }
        NSString *language = voice[@"language"];
        NSString *voiceName = voice[@"name"];
        NSDictionary *environment = NSProcessInfo.processInfo.environment;
        NSString *firstText = environment[@"BERD_SIRI_TEST_FIRST_TEXT"] ?: @"Yes.";
        NSString *secondText = environment[@"BERD_SIRI_TEST_SECOND_TEXT"] ?:
            @"A gentle breeze is moving through the trees outside while the afternoon light "
             "stretches across the room.";
        NSArray *firstPackets = BerdCaptureSiriPackets(firstText, language, voiceName, &error);
        if (!firstPackets) {
            fprintf(stderr, "synthesize first sentence: %s\n", error.localizedDescription.UTF8String);
            return 2;
        }
        NSArray *secondPackets = BerdCaptureSiriPackets(
            secondText, language, voiceName, &error);
        if (!secondPackets) {
            fprintf(stderr, "synthesize second sentence: %s\n", error.localizedDescription.UTF8String);
            return 2;
        }

        BerdSiriAudioDecoder *reusedDecoder = [BerdSiriAudioDecoder new];
        if (!BerdDecodePackets(firstPackets, reusedDecoder, nil, &error)) {
            fprintf(stderr, "decode first sentence: %s\n", error.localizedDescription.UTF8String);
            return 2;
        }
        if (![reusedDecoder finishConversion:&error]) {
            fprintf(stderr, "finish first sentence: %s\n", error.localizedDescription.UTF8String);
            return 2;
        }

        NSMutableData *reusedSamples = [NSMutableData data];
        if (!BerdDecodePackets(secondPackets, reusedDecoder, reusedSamples, &error)) {
            fprintf(stderr, "decode second sentence with reused decoder: %s\n",
                    error.localizedDescription.UTF8String);
            return 2;
        }
        NSArray<AVAudioPCMBuffer *> *reusedTail = [reusedDecoder finishConversion:&error];
        if (!reusedTail) {
            fprintf(stderr, "finish reused decoder: %s\n", error.localizedDescription.UTF8String);
            return 2;
        }
        for (AVAudioPCMBuffer *buffer in reusedTail) {
            [reusedSamples appendBytes:buffer.floatChannelData[0]
                                length:buffer.frameLength * sizeof(float)];
        }

        BerdSiriAudioDecoder *freshDecoder = [BerdSiriAudioDecoder new];
        NSMutableData *freshSamples = [NSMutableData data];
        if (!BerdDecodePackets(secondPackets, freshDecoder, freshSamples, &error)) {
            fprintf(stderr, "decode second sentence with fresh decoder: %s\n",
                    error.localizedDescription.UTF8String);
            return 2;
        }
        NSArray<AVAudioPCMBuffer *> *freshTail = [freshDecoder finishConversion:&error];
        if (!freshTail) {
            fprintf(stderr, "finish fresh decoder: %s\n", error.localizedDescription.UTF8String);
            return 2;
        }
        for (AVAudioPCMBuffer *buffer in freshTail) {
            [freshSamples appendBytes:buffer.floatChannelData[0]
                               length:buffer.frameLength * sizeof(float)];
        }

        BerdAudioComparison comparison = BerdCompareAudio(reusedSamples, freshSamples);
        printf("voice=%s (%s)\n", voiceName.UTF8String, language.UTF8String);
        printf("first_packets=%lu second_packets=%lu\n",
               (unsigned long)firstPackets.count, (unsigned long)secondPackets.count);
        printf("reused_frames=%lu fresh_frames=%lu lag=%ld unmatched_frames=%lu correlation=%.12f "
               "aligned_normalized_rmse=%.12f\n",
               (unsigned long)(reusedSamples.length / sizeof(float)),
               (unsigned long)(freshSamples.length / sizeof(float)),
               (long)comparison.lag, (unsigned long)comparison.unmatchedFrames,
               comparison.correlation, comparison.normalizedRMSE);

        if (labs(comparison.lag) > 512 ||
            comparison.unmatchedFrames > (NSUInteger)labs(comparison.lag) + 1 ||
            comparison.correlation < 0.9999 ||
            comparison.normalizedRMSE > 0.001) {
            fprintf(stderr,
                    "FAIL: the second independent Siri stream is distorted after alignment.\n");
            return 1;
        }
        printf("PASS: the second Siri stream matches a fresh decoder after delay alignment.\n");
        return 0;
    }
}
