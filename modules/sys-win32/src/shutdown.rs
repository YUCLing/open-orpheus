//! Powering the machine off, driven by the app's own auto-exit countdown.
//!
//! Windows cannot report which shutdown is pending and cannot retime one, so the
//! countdown lives in the main process and the system is only asked to power off
//! at the deadline: `InitiateSystemShutdownExW` with a zero timeout shuts down
//! without the modal dialog and cannot be stopped by `AbortSystemShutdown`,
//! which is exactly what a sleep timer needs.

use napi::{Error, Result};
use napi_derive::napi;
use windows::{
    core::{HRESULT, HSTRING, PCWSTR},
    Win32::{
        Foundation::{
            CloseHandle, GetLastError, SetLastError, ERROR_NOT_ALL_ASSIGNED,
            ERROR_SHUTDOWN_IN_PROGRESS, ERROR_SUCCESS, HANDLE, LUID,
        },
        Security::{
            AdjustTokenPrivileges, LookupPrivilegeValueW, LUID_AND_ATTRIBUTES,
            SE_PRIVILEGE_ENABLED, SE_SHUTDOWN_NAME, TOKEN_ADJUST_PRIVILEGES, TOKEN_PRIVILEGES,
            TOKEN_QUERY,
        },
        System::{
            Shutdown::{
                InitiateSystemShutdownExW, SHTDN_REASON_FLAG_PLANNED,
                SHTDN_REASON_MAJOR_APPLICATION, SHTDN_REASON_MINOR_MAINTENANCE,
            },
            Threading::{GetCurrentProcess, OpenProcessToken},
        },
    },
};

use crate::napi_err;

/// Whether this process can power the machine off.
///
/// Enabling `SeShutdownPrivilege` is what the answer is based on: Windows grants
/// it to interactive users but leaves it disabled until it is asked for. This is
/// a capability check, not a guarantee: the system can still refuse the request
/// itself, for reasons this cannot see from here.
#[napi]
pub fn can_shutdown() -> Result<bool> {
    enable_shutdown_privilege()
}

/// Power the machine off immediately.
///
/// `message` is shown by the system while it shuts down, and
/// `force_apps_closed` decides whether applications with unsaved changes are
/// closed instead of blocking the shutdown.
///
/// A shutdown that is already in progress counts as success: the machine is
/// going down either way, which is the state the caller asked for.
#[napi]
pub fn shutdown_now(message: String, force_apps_closed: bool) -> Result<()> {
    if !enable_shutdown_privilege()? {
        return Err(Error::from_reason(
            "SeShutdownPrivilege is not held by this process".to_string(),
        ));
    }

    // A planned shutdown: reason zero is logged as unplanned, which can make the
    // system save state before powering down.
    let reason =
        SHTDN_REASON_MAJOR_APPLICATION | SHTDN_REASON_MINOR_MAINTENANCE | SHTDN_REASON_FLAG_PLANNED;
    let message = HSTRING::from(message);

    // A zero timeout means no dialog and no way back, which is what the caller
    // needs: its countdown has already reached zero. The machine name is null so
    // that this machine is shut down, and the shutdown never restarts the system.
    let request = unsafe {
        InitiateSystemShutdownExW(
            None::<&PCWSTR>,
            &message,
            0,
            force_apps_closed,
            false, // Power off rather than restart.
            reason,
        )
    };

    interpret_shutdown_request(request)
}

/// Turn the system's answer to a shutdown request into this module's contract.
///
/// `ERROR_SHUTDOWN_IN_PROGRESS` is the one refusal that is not a failure: a
/// shutdown is already taking the machine down, so the caller is getting what it
/// asked for even though this particular request was not the one accepted.
fn interpret_shutdown_request(request: windows::core::Result<()>) -> Result<()> {
    match request {
        Ok(()) => Ok(()),
        Err(error) if error.code() == HRESULT::from_win32(ERROR_SHUTDOWN_IN_PROGRESS.0) => Ok(()),
        Err(error) => Err(napi_err(error)),
    }
}

/// Enable `SeShutdownPrivilege` in this process's token.
///
/// The privilege is held by interactive users but disabled, and the shutdown
/// APIs require it enabled; enabling it needs no elevation and lasts for the
/// process, so this doubles as the arming step behind [`can_shutdown`].
///
/// Returns `Ok(false)` when the token does not hold the privilege at all (this
/// process cannot power the machine off), and `Err` when the token itself could
/// not be queried.
fn enable_shutdown_privilege() -> Result<bool> {
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY,
            &mut token,
        )
        .map_err(napi_err)?;

        let outcome = enable_in_token(token);
        // Closed whatever the outcome, including the failures above.
        let _ = CloseHandle(token);
        outcome
    }
}

/// The `AdjustTokenPrivileges` half of [`enable_shutdown_privilege`], split out
/// so that the token is closed on every path.
///
/// # Safety
///
/// `token` must be a token handle opened with `TOKEN_ADJUST_PRIVILEGES`.
unsafe fn enable_in_token(token: HANDLE) -> Result<bool> {
    let mut luid = LUID::default();
    LookupPrivilegeValueW(None, SE_SHUTDOWN_NAME, &mut luid).map_err(napi_err)?;

    let privileges = TOKEN_PRIVILEGES {
        PrivilegeCount: 1,
        Privileges: [LUID_AND_ATTRIBUTES {
            Luid: luid,
            Attributes: SE_PRIVILEGE_ENABLED,
        }],
    };

    // A successful call can still mean "this privilege was not assigned"; that
    // case is reported through the last error rather than the return value, so
    // it is cleared first.
    SetLastError(ERROR_SUCCESS);
    AdjustTokenPrivileges(token, false, Some(&privileges as *const _), 0, None, None)
        .map_err(napi_err)?;

    Ok(GetLastError() != ERROR_NOT_ALL_ASSIGNED)
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::{core::Error as WindowsError, Win32::Foundation::ERROR_ACCESS_DENIED};

    fn refusal(code: u32) -> WindowsError {
        WindowsError::from_hresult(HRESULT::from_win32(code))
    }

    #[test]
    fn accepts_a_request_the_system_took() {
        assert!(interpret_shutdown_request(Ok(())).is_ok());
    }

    #[test]
    fn accepts_a_shutdown_that_is_already_in_progress() {
        // Somebody else's shutdown takes the machine down just the same, so the
        // caller's request is satisfied even though this one was refused.
        let request = Err(refusal(ERROR_SHUTDOWN_IN_PROGRESS.0));

        assert!(interpret_shutdown_request(request).is_ok());
    }

    #[test]
    fn reports_every_other_refusal() {
        let request = Err(refusal(ERROR_ACCESS_DENIED.0));

        assert!(interpret_shutdown_request(request).is_err());
    }
}
