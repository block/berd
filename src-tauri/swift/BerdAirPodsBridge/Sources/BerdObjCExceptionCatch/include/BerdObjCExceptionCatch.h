#import <Foundation/Foundation.h>

/// Runs a block inside an Objective-C @try/@catch so Swift callers can handle
/// AVAudioEngine NSExceptions without terminating the process.
BOOL BerdTryObjCBlock(void (NS_NOESCAPE ^_Nonnull block)(void),
                      NSError *_Nullable *_Nullable error);
