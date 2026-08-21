#import "BerdObjCExceptionCatch.h"

// Adapted from voice-conversation-cli's VCTryObjCBlock.
BOOL BerdTryObjCBlock(void (NS_NOESCAPE ^_Nonnull block)(void),
                      NSError *_Nullable *_Nullable error) {
    @try {
        block();
        return YES;
    } @catch (NSException *exception) {
        if (error) {
            *error = [NSError errorWithDomain:@"com.berd.objc-exception"
                                         code:-1
                                     userInfo:@{
                NSLocalizedDescriptionKey: exception.reason ?: exception.name,
            }];
        }
        return NO;
    }
}
