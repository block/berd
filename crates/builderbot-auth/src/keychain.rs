//! macOS Keychain helpers using the modern SecItem* APIs with access group support.
//!
//! This module stores generic password items with a shared `kSecAttrAccessGroup` so
//! that multiple binaries signed by the same team (e.g. the Goose .app and the bb CLI)
//! can read/write the same keychain items without triggering separate permission prompts.

use anyhow::{anyhow, Result};
use core::ffi::c_void;
use core_foundation::array::CFArray;
use core_foundation::base::{kCFAllocatorDefault, CFAllocatorRef, CFType, CFTypeRef, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::data::CFData;
use core_foundation::dictionary::CFMutableDictionary;
use core_foundation::error::{CFError, CFErrorRef};
use core_foundation::number::CFNumber;
use core_foundation::string::{CFString, CFStringRef};
use security_framework_sys::item::{
    kSecAttrAccessGroup, kSecAttrAccount, kSecAttrService, kSecClass, kSecClassGenericPassword,
    kSecMatchLimit, kSecReturnData, kSecValueData,
};
use security_framework_sys::keychain_item::{
    SecItemAdd, SecItemCopyMatching, SecItemDelete, SecItemUpdate,
};
use std::ptr;

const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;
const KEYCHAIN_ACCESS_GROUPS_ENTITLEMENT: &str = "keychain-access-groups";
const SHARED_AUTH_ACCESS_GROUP_SUFFIX: &str = ".com.squareup.builderbot.shared-auth";

type SecTaskRef = *const c_void;

#[link(name = "Security", kind = "framework")]
extern "C" {
    fn SecTaskCreateFromSelf(allocator: CFAllocatorRef) -> SecTaskRef;
    fn SecTaskCopyValueForEntitlement(
        task: SecTaskRef,
        entitlement: CFStringRef,
        error: *mut CFErrorRef,
    ) -> CFTypeRef;
}

pub fn shared_auth_access_group() -> Result<String> {
    let groups = current_keychain_access_groups()?;
    select_shared_auth_access_group(groups.iter().map(String::as_str)).ok_or_else(|| {
        anyhow!(
            "signed binary is missing BuilderBot shared auth keychain access group ending in {SHARED_AUTH_ACCESS_GROUP_SUFFIX}"
        )
    })
}

fn current_keychain_access_groups() -> Result<Vec<String>> {
    let task_ref = unsafe { SecTaskCreateFromSelf(kCFAllocatorDefault) };
    if task_ref.is_null() {
        anyhow::bail!("create security task for current process");
    }
    let task = unsafe { CFType::wrap_under_create_rule(task_ref as CFTypeRef) };

    let entitlement = CFString::new(KEYCHAIN_ACCESS_GROUPS_ENTITLEMENT);
    let mut error: CFErrorRef = ptr::null_mut();
    let value_ref = unsafe {
        SecTaskCopyValueForEntitlement(
            task.as_CFTypeRef() as SecTaskRef,
            entitlement.as_concrete_TypeRef(),
            &mut error,
        )
    };
    if !error.is_null() {
        let error = unsafe { CFError::wrap_under_create_rule(error) };
        anyhow::bail!("read keychain access groups entitlement: {error}");
    }
    if value_ref.is_null() {
        anyhow::bail!("signed binary is missing keychain access groups entitlement");
    }

    let value = unsafe { CFType::wrap_under_create_rule(value_ref) };
    let groups = value
        .downcast_into::<CFArray>()
        .ok_or_else(|| anyhow!("keychain access groups entitlement is not an array"))?;
    let mut access_groups = Vec::new();
    for value in groups.get_all_values() {
        let value = unsafe { CFType::wrap_under_get_rule(value as CFTypeRef) };
        if let Some(group) = value.downcast::<CFString>() {
            access_groups.push(group.to_string());
        }
    }
    if access_groups.is_empty() {
        anyhow::bail!("keychain access groups entitlement contains no string values");
    }
    Ok(access_groups)
}

fn select_shared_auth_access_group<'a>(
    groups: impl IntoIterator<Item = &'a str>,
) -> Option<String> {
    groups
        .into_iter()
        .find(|group| group.ends_with(SHARED_AUTH_ACCESS_GROUP_SUFFIX))
        .map(ToString::to_string)
}

/// Get a generic password from the keychain, scoped to the given access group.
pub fn get_generic_password(
    service: &str,
    account: &str,
    access_group: &str,
) -> Result<Option<Vec<u8>>> {
    get_generic_password_with_access_group(service, account, Some(access_group))
}

/// Get a generic password from the default keychain scope.
pub fn get_generic_password_unscoped(service: &str, account: &str) -> Result<Option<Vec<u8>>> {
    get_generic_password_with_access_group(service, account, None)
}

fn get_generic_password_with_access_group(
    service: &str,
    account: &str,
    access_group: Option<&str>,
) -> Result<Option<Vec<u8>>> {
    let mut query = build_query(service, account, access_group);
    query.set(
        unsafe { CFString::wrap_under_get_rule(kSecReturnData) },
        CFBoolean::true_value().as_CFType(),
    );
    query.set(
        unsafe { CFString::wrap_under_get_rule(kSecMatchLimit) },
        CFNumber::from(1).as_CFType(),
    );

    let mut result: core_foundation::base::CFTypeRef = ptr::null();
    let status = unsafe { SecItemCopyMatching(query.as_concrete_TypeRef(), &mut result) };

    if status == ERR_SEC_ITEM_NOT_FOUND {
        return Ok(None);
    }
    if status != 0 {
        return Err(anyhow!(
            "read keychain item (service={service}, account={account}): OSStatus {status}"
        ));
    }

    let data = unsafe { CFData::wrap_under_create_rule(result as *const _) };
    Ok(Some(data.bytes().to_vec()))
}

/// Set (add or update) a generic password in the keychain, scoped to the given access group.
pub fn set_generic_password(
    service: &str,
    account: &str,
    access_group: &str,
    value: &[u8],
) -> Result<()> {
    set_generic_password_with_access_group(service, account, Some(access_group), value)
}

/// Set (add or update) a generic password in the default keychain scope.
pub fn set_generic_password_unscoped(service: &str, account: &str, value: &[u8]) -> Result<()> {
    set_generic_password_with_access_group(service, account, None, value)
}

fn set_generic_password_with_access_group(
    service: &str,
    account: &str,
    access_group: Option<&str>,
    value: &[u8],
) -> Result<()> {
    let value_data = CFData::from_buffer(value);

    // Try to update first
    let query = build_query(service, account, access_group);
    let mut update_attrs = CFMutableDictionary::new();
    update_attrs.set(
        unsafe { CFString::wrap_under_get_rule(kSecValueData) },
        value_data.as_CFType(),
    );

    let status = unsafe {
        SecItemUpdate(
            query.as_concrete_TypeRef(),
            update_attrs.as_concrete_TypeRef(),
        )
    };

    if status == ERR_SEC_ITEM_NOT_FOUND {
        // Item doesn't exist, add it
        let mut add_attrs = build_query(service, account, access_group);
        add_attrs.set(
            unsafe { CFString::wrap_under_get_rule(kSecValueData) },
            value_data.as_CFType(),
        );

        let add_status = unsafe { SecItemAdd(add_attrs.as_concrete_TypeRef(), ptr::null_mut()) };
        if add_status != 0 {
            return Err(anyhow!(
                "add keychain item (service={service}, account={account}): OSStatus {add_status}"
            ));
        }
        return Ok(());
    }

    if status != 0 {
        return Err(anyhow!(
            "update keychain item (service={service}, account={account}): OSStatus {status}"
        ));
    }

    Ok(())
}

/// Delete a generic password from the keychain, scoped to the given access group.
/// Returns `true` if an item was deleted, `false` if it was not found.
pub fn delete_generic_password(service: &str, account: &str, access_group: &str) -> Result<bool> {
    delete_generic_password_with_access_group(service, account, Some(access_group))
}

/// Delete a generic password from the default keychain scope.
/// Returns `true` if an item was deleted, `false` if it was not found.
pub fn delete_generic_password_unscoped(service: &str, account: &str) -> Result<bool> {
    delete_generic_password_with_access_group(service, account, None)
}

fn delete_generic_password_with_access_group(
    service: &str,
    account: &str,
    access_group: Option<&str>,
) -> Result<bool> {
    let query = build_query(service, account, access_group);
    let status = unsafe { SecItemDelete(query.as_concrete_TypeRef()) };

    if status == ERR_SEC_ITEM_NOT_FOUND {
        return Ok(false);
    }
    if status != 0 {
        return Err(anyhow!(
            "delete keychain item (service={service}, account={account}): OSStatus {status}"
        ));
    }
    Ok(true)
}

fn build_query(
    service: &str,
    account: &str,
    access_group: Option<&str>,
) -> CFMutableDictionary<CFString, CFType> {
    let mut dict = CFMutableDictionary::new();
    dict.set(
        unsafe { CFString::wrap_under_get_rule(kSecClass) },
        unsafe { CFType::wrap_under_get_rule(kSecClassGenericPassword as *const _) },
    );
    dict.set(
        unsafe { CFString::wrap_under_get_rule(kSecAttrService) },
        CFString::new(service).as_CFType(),
    );
    dict.set(
        unsafe { CFString::wrap_under_get_rule(kSecAttrAccount) },
        CFString::new(account).as_CFType(),
    );
    if let Some(access_group) = access_group {
        dict.set(
            unsafe { CFString::wrap_under_get_rule(kSecAttrAccessGroup) },
            CFString::new(access_group).as_CFType(),
        );
    }
    dict
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selects_builderbot_shared_auth_access_group() {
        assert_eq!(
            select_shared_auth_access_group([
                "EYF346PHUG.com.squareup.other",
                "EYF346PHUG.com.squareup.builderbot.shared-auth",
            ]),
            Some("EYF346PHUG.com.squareup.builderbot.shared-auth".to_string())
        );
    }

    #[test]
    fn ignores_non_builderbot_access_groups() {
        assert_eq!(
            select_shared_auth_access_group(["EYF346PHUG.com.squareup.other"]),
            None
        );
    }
}
