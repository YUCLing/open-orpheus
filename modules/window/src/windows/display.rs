use napi::{Error, Result};
use windows::{
    Devices::Display::Core::{DisplayManager, DisplayManagerOptions},
    Graphics::DisplayAdapterId,
    Win32::{
        Devices::Display::{
            DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME, DISPLAYCONFIG_MODE_INFO,
            DISPLAYCONFIG_PATH_INFO, DISPLAYCONFIG_SOURCE_DEVICE_NAME, DisplayConfigGetDeviceInfo,
            GetDisplayConfigBufferSizes, QDC_ONLY_ACTIVE_PATHS, QueryDisplayConfig,
        },
        Foundation::{ERROR_INSUFFICIENT_BUFFER, ERROR_SUCCESS, LPARAM, LUID, RECT},
        Graphics::Gdi::{EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFOEXW},
    },
    core::BOOL,
};

/// The GDI monitor backing Chromium's `Display.id`.
pub fn monitor_from_display(display_id: u32) -> Option<HMONITOR> {
    let path = find_display_path(display_id).ok().flatten()?;
    monitor_from_path(&path)
}

/// The session-independent monitor id for Chromium's `Display.id`.
pub fn stable_monitor_id(display_id: u32) -> Result<Option<String>> {
    let Some(path) = find_display_path(display_id)? else {
        return Ok(None);
    };

    stable_monitor_id_for_path(&path)
}

fn to_luid(id: DisplayAdapterId) -> LUID {
    LUID {
        LowPart: id.LowPart,
        HighPart: id.HighPart,
    }
}

/// Chromium's `Display.id` for one active display path.
fn display_id_for_path(path: &DISPLAYCONFIG_PATH_INFO) -> u32 {
    let target = &path.targetInfo;
    sfhash::digest(
        format!(
            "{}/{}/{}",
            target.adapterId.LowPart, target.adapterId.HighPart, target.id
        )
        .as_bytes(),
    )
}

/// Every active display path, retrying when the topology changes between the
/// size query and the fetch.
fn active_display_paths() -> Result<Vec<DISPLAYCONFIG_PATH_INFO>> {
    for _ in 0..2 {
        let mut path_count = 0u32;
        let mut mode_count = 0u32;
        let status = unsafe {
            GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut path_count, &mut mode_count)
        };
        if status != ERROR_SUCCESS {
            return Err(Error::from_reason(
                windows::core::Error::from_thread().message(),
            ));
        }

        let mut paths = vec![DISPLAYCONFIG_PATH_INFO::default(); path_count as usize];
        let mut modes = vec![DISPLAYCONFIG_MODE_INFO::default(); mode_count as usize];
        let status = unsafe {
            QueryDisplayConfig(
                QDC_ONLY_ACTIVE_PATHS,
                &mut path_count,
                paths.as_mut_ptr(),
                &mut mode_count,
                modes.as_mut_ptr(),
                None,
            )
        };
        if status == ERROR_INSUFFICIENT_BUFFER {
            continue;
        }
        if status != ERROR_SUCCESS {
            return Err(Error::from_reason(
                windows::core::Error::from_thread().message(),
            ));
        }

        paths.truncate(path_count as usize);
        return Ok(paths);
    }

    Err(Error::from_reason(
        "display configuration kept changing while enumerating",
    ))
}

/// The active path Chromium reports as `display_id`.
fn find_display_path(display_id: u32) -> Result<Option<DISPLAYCONFIG_PATH_INFO>> {
    Ok(active_display_paths()?
        .into_iter()
        .find(|path| display_id_for_path(path) == display_id))
}

fn stable_monitor_id_for_path(path: &DISPLAYCONFIG_PATH_INFO) -> Result<Option<String>> {
    let options = DisplayManagerOptions::default();
    let manager = DisplayManager::Create(options).map_err(|x| Error::from_reason(x.message()))?;
    let targets = manager
        .GetCurrentTargets()
        .map_err(|x| Error::from_reason(x.message()))?;

    Ok(targets
        .into_iter()
        .find(|target| {
            target.AdapterRelativeId().ok() == Some(path.targetInfo.id)
                && target.Adapter().and_then(|a| a.Id()).map(to_luid).ok()
                    == Some(path.targetInfo.adapterId)
        })
        .and_then(|target| target.StableMonitorId().ok())
        .map(|id| id.to_string_lossy()))
}

struct MonitorSearch {
    device: [u16; 32],
    found: Option<HMONITOR>,
}

fn wide_eq(a: &[u16], b: &[u16]) -> bool {
    fn trim(value: &[u16]) -> &[u16] {
        let end = value.iter().position(|&c| c == 0).unwrap_or(value.len());
        &value[..end]
    }

    trim(a) == trim(b)
}

unsafe extern "system" fn enum_monitor_proc(
    monitor: HMONITOR,
    _hdc: HDC,
    _clip: *mut RECT,
    lparam: LPARAM,
) -> BOOL {
    let search = unsafe { &mut *(lparam.0 as *mut MonitorSearch) };
    let mut info = MONITORINFOEXW::default();
    info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;

    if unsafe { GetMonitorInfoW(monitor, &mut info.monitorInfo) }.as_bool()
        && wide_eq(&info.szDevice, &search.device)
    {
        search.found = Some(monitor);
        return false.into();
    }

    true.into()
}

/// The GDI monitor whose source device backs a display path.
fn monitor_from_path(path: &DISPLAYCONFIG_PATH_INFO) -> Option<HMONITOR> {
    let mut source = DISPLAYCONFIG_SOURCE_DEVICE_NAME::default();
    source.header.r#type = DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME;
    source.header.size = std::mem::size_of::<DISPLAYCONFIG_SOURCE_DEVICE_NAME>() as u32;
    source.header.adapterId = path.sourceInfo.adapterId;
    source.header.id = path.sourceInfo.id;

    let status = unsafe { DisplayConfigGetDeviceInfo(&mut source.header) };
    if status != ERROR_SUCCESS.0 as i32 {
        return None;
    }

    let mut search = MonitorSearch {
        device: source.viewGdiDeviceName,
        found: None,
    };
    unsafe {
        let _ = EnumDisplayMonitors(
            None,
            None,
            Some(enum_monitor_proc),
            LPARAM(&mut search as *mut MonitorSearch as isize),
        );
    }

    search.found
}
