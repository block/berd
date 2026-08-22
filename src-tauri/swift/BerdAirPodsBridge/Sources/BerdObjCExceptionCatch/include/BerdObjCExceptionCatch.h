#import <Foundation/Foundation.h>

BOOL BerdTryObjCBlock(void (NS_NOESCAPE ^_Nonnull block)(void),
                      NSError *_Nullable *_Nullable error);
