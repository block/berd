//! macOS Keychain helpers using the modern SecItem* APIs.

use anyhow::{anyhow, Result};
use core_foundation::base::{CFType, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::data::CFData;
use core_foundation::dictionary::CFMutableDictionary;
use core_foundation::number::CFNumber;
use core_foundation::string::CFString;
use security_framework_sys::item::{
    kSecAttrAccount, kSecAttrService, kSecClass, kSecClassGenericPassword, kSecMatchLimit,
    kSecReturnData, kSecValueData,
};
use security_framework_sys::keychain_item::{
    SecItemAdd, SecItemCopyMatching, SecItemDelete, SecItemUpdate,
};
use std::ptr;

const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

/// Get a generic password from the default keychain scope.
pub fn get_generic_password_unscoped(service: &str, account: &str) -> Result<Option<Vec<u8>>> {
    let mut query = build_query(service, account);
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

/// Set (add or update) a generic password in the default keychain scope.
pub fn set_generic_password_unscoped(service: &str, account: &str, value: &[u8]) -> Result<()> {
    let value_data = CFData::from_buffer(value);

    // Try to update first
    let query = build_query(service, account);
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
        let mut add_attrs = build_query(service, account);
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

/// Delete a generic password from the default keychain scope.
/// Returns `true` if an item was deleted, `false` if it was not found.
pub fn delete_generic_password_unscoped(service: &str, account: &str) -> Result<bool> {
    let query = build_query(service, account);
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

fn build_query(service: &str, account: &str) -> CFMutableDictionary<CFString, CFType> {
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
    dict
}

#[cfg(test)]
mod tests {
    use super::*;
    use core_foundation::base::TCFType;
    use security_framework_sys::item::kSecAttrAccessGroup;

    #[test]
    fn build_query_does_not_scope_to_access_group() {
        let query = build_query("com.squareup.builderbot.cli-auth", "default@example");

        assert_eq!(query.len(), 3);
        assert!(
            query.contains_key(unsafe { CFString::wrap_under_get_rule(kSecClass).as_CFTypeRef() })
        );
        assert!(query.contains_key(unsafe {
            CFString::wrap_under_get_rule(kSecAttrService).as_CFTypeRef()
        }));
        assert!(query.contains_key(unsafe {
            CFString::wrap_under_get_rule(kSecAttrAccount).as_CFTypeRef()
        }));
        assert!(!query.contains_key(unsafe {
            CFString::wrap_under_get_rule(kSecAttrAccessGroup).as_CFTypeRef()
        }));
    }
}
