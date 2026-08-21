#import "BerdObjCExceptionCatch.h"

BOOL BerdTryObjCBlock(void (NS_NOESCAPE ^_Nonnull block)(void),
                      NSError *_Nullable *_Nullable error) {
    @try {
        block();
        return YES;
    } @catch (NSException *exception) {
        if (error) {
            NSDictionary *userInfo = @{
                NSLocalizedDescriptionKey: exception.reason ?: exception.name,
                @"NSExceptionName": exception.name,
            };
            *error = [NSError errorWithDomain:@"com.berd.objc-exception"
                                         code:-1
                                     userInfo:userInfo];
        }
        return NO;
    }
}
