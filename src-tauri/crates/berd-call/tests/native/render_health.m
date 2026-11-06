// Offline AudioUnits only: no engine, device selection, capture or playback.
#import "../../native/siri_tts_bridge.m"
#import <assert.h>

@interface TestAudioNode : NSObject
@property(nonatomic, strong) AUAudioUnit *AUAudioUnit;
@end
@implementation TestAudioNode
@end

@interface TestRunningEngine : NSObject
@property(nonatomic, strong) TestAudioNode *outputNode;
@property(nonatomic, strong) TestAudioNode *mainMixerNode;
@property(nonatomic, weak) BerdPocketAudioPlayer *player;
@property(nonatomic, assign) BOOL running;
- (BOOL)isRunning;
- (void)stop;
@end
@implementation TestRunningEngine
- (BOOL)isRunning {
    // A completion callback must be able to acquire the monitor during this query.
    dispatch_semaphore_t completed = dispatch_semaphore_create(0);
    BerdPocketAudioPlayer *player = self.player;
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_DEFAULT, 0), ^{
        @synchronized (player) { dispatch_semaphore_signal(completed); }
    });
    assert(dispatch_semaphore_wait(completed,
        dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC)) == 0);
    return self.running;
}
- (void)stop {}
@end

static AUAudioUnit *offlineUnit(void) {
    AudioComponentDescription description = {
        kAudioUnitType_FormatConverter, kAudioUnitSubType_NewTimePitch,
        kAudioUnitManufacturer_Apple, 0, 0
    };
    NSError *error = nil;
    AUAudioUnit *unit = [[AUAudioUnit alloc] initWithComponentDescription:description error:&error];
    assert(unit && !error);
    AVAudioFormat *format = [[AVAudioFormat alloc] initStandardFormatWithSampleRate:48000 channels:1];
    assert([unit.inputBusses[0] setFormat:format error:&error]);
    assert([unit.outputBusses[0] setFormat:format error:&error]);
    unit.maximumFramesToRender = 941;
    assert([unit allocateRenderResourcesAndReturnError:&error]);
    return unit;
}

int main(void) {
    @autoreleasepool {
        for (NSUInteger failedNode = 0; failedNode < 3; failedNode++) {
            AUAudioUnit *units[] = {offlineUnit(), offlineUnit(), offlineUnit()};
            TestAudioNode *nodes[3];
            for (NSUInteger i = 0; i < 3; i++) {
                nodes[i] = [TestAudioNode new];
                nodes[i].AUAudioUnit = units[i];
            }
            TestRunningEngine *engine = [TestRunningEngine new];
            engine.outputNode = nodes[0];
            engine.mainMixerNode = nodes[2];
            engine.running = YES;
            // Bypass the hardware-opening initializer; exercise the real bridge health path.
            BerdPocketAudioPlayer *player = [BerdPocketAudioPlayer new];
            player.engine = (AVAudioEngine *)engine;
            engine.player = player;
            player.timePitch = (AVAudioUnitTimePitch *)nodes[1];
            [player observeRenderErrors];
            void *opaque = (__bridge void *)player;
            assert(!berd_pocket_audio_player_failed(opaque));

            AudioTimeStamp timestamp = {0};
            timestamp.mFlags = kAudioTimeStampSampleTimeValid;
            float samples[960] = {0};
            AudioBufferList buffers = {1, {{1, sizeof(samples), samples}}};
            AudioUnitRenderActionFlags flags = 0;
            assert(units[failedNode].renderBlock(&flags, &timestamp, 960, 0, &buffers, nil)
                == kAudioUnitErr_TooManyFramesToProcess);
            assert(berd_pocket_audio_player_failed(opaque));
            // A fresh render allocation clears the unit's error, not the player's failure.
            [units[failedNode] deallocateRenderResources];
            NSError *error = nil;
            assert([units[failedNode] allocateRenderResourcesAndReturnError:&error]);
            assert(berd_pocket_audio_player_failed(opaque));
            [player stop];
            assert(!berd_pocket_audio_player_failed(opaque));
            for (NSUInteger i = 0; i < 3; i++) {
                [units[i] deallocateRenderResources];
            }
        }
        assert(berd_pocket_audio_player_failed(NULL));
    }
}
