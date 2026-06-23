#import <Foundation/Foundation.h>
#import <Security/Security.h>
#import <sys/wait.h>

static AuthorizationRef builderbotGetSymlinkAuthorization(void) {
  AuthorizationRef authRef = NULL;
  OSStatus err = AuthorizationCreate(NULL, kAuthorizationEmptyEnvironment,
                                     kAuthorizationFlagDefaults, &authRef);
  if (err != errAuthorizationSuccess) {
    return NULL;
  }

  NSString *bundleIdentifier = [[NSBundle mainBundle] bundleIdentifier] ?: @"com.squareup.builderbot";
  NSString *rightNameString = [NSString stringWithFormat:@"%@.symlink", bundleIdentifier];
  const char *rightName = [rightNameString UTF8String];

  OSStatus getRightResult = AuthorizationRightGet(rightName, NULL);
  if (getRightResult == errAuthorizationDenied) {
    NSString *prompt = @"BuilderBot is trying to install its command line interface (CLI) tool.";
    err = AuthorizationRightSet(authRef, rightName,
                                (__bridge CFTypeRef)@(kAuthorizationRuleAuthenticateAsAdmin),
                                (__bridge CFStringRef)prompt, NULL, NULL);
    if (err != errAuthorizationSuccess) {
      AuthorizationFree(authRef, kAuthorizationFlagDestroyRights);
      return NULL;
    }
  }

  AuthorizationItem rightItem = {
      .name = rightName,
      .valueLength = 0,
      .value = NULL,
      .flags = 0,
  };
  AuthorizationRights rights = {
      .count = 1,
      .items = &rightItem,
  };
  AuthorizationFlags flags = kAuthorizationFlagExtendRights | kAuthorizationFlagInteractionAllowed;

  err = AuthorizationCopyRights(authRef, &rights, NULL, flags, NULL);
  if (err != errAuthorizationSuccess) {
    AuthorizationFree(authRef, kAuthorizationFlagDestroyRights);
    return NULL;
  }

  return authRef;
}

static int builderbotRunPrivilegedTool(AuthorizationRef authRef, const char *tool,
                                       const char *const args[]) {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  OSStatus err = AuthorizationExecuteWithPrivileges(
      authRef, tool, kAuthorizationFlagDefaults, (char *const *)args, NULL);
#pragma clang diagnostic pop

  if (err != errAuthorizationSuccess) {
    return (int)err;
  }

  int status = 0;
  pid_t pid = wait(&status);
  if (pid == -1) {
    return -1;
  }
  if (!WIFEXITED(status)) {
    return -2;
  }
  if (WEXITSTATUS(status) != 0) {
    return -100 - WEXITSTATUS(status);
  }
  return 0;
}

int bbInstallSymlinkWithAuthorization(const char *cliPath) {
  if (cliPath == NULL || cliPath[0] == '\0') {
    return -10;
  }

  NSString *linkPath = @"/usr/local/bin/bb";
  NSString *dirPath = @"/usr/local/bin";
  NSString *targetPath = [NSString stringWithUTF8String:cliPath];
  NSFileManager *fileManager = [NSFileManager defaultManager];
  NSError *error = nil;
  NSString *symlinkPath = [fileManager destinationOfSymbolicLinkAtPath:linkPath error:&error];

  if ([symlinkPath isEqualToString:targetPath]) {
    return 0;
  }

  AuthorizationRef authRef = builderbotGetSymlinkAuthorization();
  if (authRef == NULL) {
    return -11;
  }

  BOOL isDirectory = NO;
  if (![fileManager fileExistsAtPath:dirPath isDirectory:&isDirectory] || !isDirectory) {
    const char *mkdirArgs[] = {"-p", [dirPath UTF8String], NULL};
    int mkdirStatus = builderbotRunPrivilegedTool(authRef, "/bin/mkdir", mkdirArgs);
    if (mkdirStatus != 0) {
      AuthorizationFree(authRef, kAuthorizationFlagDestroyRights);
      return mkdirStatus;
    }
  }

  const char *lnArgs[] = {"-sfn", cliPath, [linkPath UTF8String], NULL};
  int lnStatus = builderbotRunPrivilegedTool(authRef, "/bin/ln", lnArgs);
  AuthorizationFree(authRef, kAuthorizationFlagDestroyRights);
  return lnStatus;
}
