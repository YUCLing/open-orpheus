#![deny(clippy::all)]

//! N-API bindings around the [`avs3a`] decoder for AV3A audio stored in an
//! M4A / MP4 container.
//!
//! The decoder is synchronous native code: every call performs file I/O plus
//! CPU-heavy synthesis on the calling thread. Run it from a worker thread
//! (e.g. an Electron `worker_thread`) when it must not block the main process.

use std::fs::File;
use std::sync::{Arc, Mutex};

use napi::{
    bindgen_prelude::{ArrayBuffer, Null, Object, ToNapiValue},
    Env, Error, Result,
};
use napi_derive::napi;

use avs3a::{BuiltinDecoder, Mp4FrameReader};

/// How many frames are decoded and discarded before a seek target so that
/// overlap-add state is warm when the requested frame is produced. Larger than
/// any backend's warm-up depth (HOA is the deepest).
const SEEK_WARMUP_FRAMES: usize = 32;

struct Inner {
    /// `None` once [`Av3aM4aDecoder::close`] has released the file handle.
    reader: Option<Mp4FrameReader<File>>,
    /// Lazily configured on the first decoded frame.
    decoder: Option<BuiltinDecoder>,
    /// Reused interleaved PCM16 scratch buffer.
    pcm: Vec<i16>,
    /// Frames strictly below this track index are decoded and discarded
    /// (used after a seek to warm the synthesis overlap).
    discard_until: usize,
    frame_count: usize,
    sample_rate: u32,
    channels: u16,
    duration_seconds: f64,
    media_start: u64,
    media_end: u64,
}

fn lock_error() -> Error {
    Error::from_reason("av3a decoder is closed or its lock is poisoned")
}

fn container_error(error: impl std::fmt::Display) -> Error {
    Error::from_reason(format!("m4a container: {error}"))
}

fn decode_error(error: impl std::fmt::Display) -> Error {
    Error::from_reason(format!("av3a decode: {error}"))
}

/// A decoder for AV3A audio inside an M4A / MP4 container.
///
/// The constructor only needs the file's `moov` box to be present; it is read
/// once to build the sample index. Media samples are read straight from the
/// file on demand, so callers that stream a partially downloaded file should
/// wait for the range reported by [`nextSampleRange`] before each
/// [`decodeNext`].
#[napi]
pub struct Av3aM4aDecoder {
    inner: Arc<Mutex<Inner>>,
}

#[napi]
impl Av3aM4aDecoder {
    /// Open an M4A/MP4 file and index its AV3A track.
    #[napi(constructor)]
    pub fn new(path: String) -> Result<Self> {
        let file = File::open(&path)
            .map_err(|error| Error::from_reason(format!("cannot open {path}: {error}")))?;
        let reader = Mp4FrameReader::open(file).map_err(|error| {
            Error::from_reason(format!(
                "not an M4A/MP4 file with an AV3A track ({path}): {error}"
            ))
        })?;
        let track = reader.track();
        let frame_count = track.samples().len();
        let sample_rate = track.declared_sample_rate();
        let channels = track.declared_channels();
        let duration_seconds = track.duration_seconds();
        let (media_start, media_end) = match track.data_range() {
            Ok(Some((start, end))) => (start, end),
            _ => (0, 0),
        };
        Ok(Self {
            inner: Arc::new(Mutex::new(Inner {
                reader: Some(reader),
                decoder: None,
                pcm: Vec::new(),
                discard_until: 0,
                frame_count,
                sample_rate,
                channels,
                duration_seconds,
                media_start,
                media_end,
            })),
        })
    }

    /// Track-level information for the opened file.
    #[napi]
    pub fn info<'env>(&self, env: &'env Env) -> Result<Object<'env>> {
        let guard = self.inner.lock().map_err(|_| lock_error())?;
        let inner = &*guard;
        let mut info = Object::new(env)?;
        info.set("sampleRate", f64::from(inner.sample_rate))?;
        info.set("channels", f64::from(inner.channels))?;
        info.set("frameCount", inner.frame_count as f64)?;
        info.set("durationSeconds", inner.duration_seconds)?;
        info.set("mediaStart", inner.media_start as f64)?;
        info.set("mediaEnd", inner.media_end as f64)?;
        Ok(info)
    }

    /// Track sample index that the next [`decodeNext`] call will read.
    #[napi]
    pub fn position(&self) -> Result<u32> {
        let guard = self.inner.lock().map_err(|_| lock_error())?;
        let inner = &*guard;
        let reader = inner.reader.as_ref().ok_or_else(lock_error)?;
        Ok(reader.position() as u32)
    }

    /// Move to an exact track frame. The frames needed to warm the decoder's
    /// overlap-add state are decoded and discarded on the following
    /// [`decodeNext`] calls.
    #[napi]
    pub fn seek_to_frame(&self, index: u32) -> Result<()> {
        let mut guard = self.inner.lock().map_err(|_| lock_error())?;
        let inner = &mut *guard;
        let target = index as usize;
        if target > inner.frame_count {
            return Err(Error::from_reason(format!(
                "frame index {target} out of range (track has {} samples)",
                inner.frame_count
            )));
        }
        let rewind = target.saturating_sub(SEEK_WARMUP_FRAMES);
        {
            let reader = inner.reader.as_mut().ok_or_else(lock_error)?;
            reader.seek_to_sample(rewind).map_err(container_error)?;
        }
        inner.decoder = None;
        inner.discard_until = target;
        Ok(())
    }

    /// Byte range of the sample the next [`decodeNext`] call will read, or
    /// `done: true` at the end of the track. A caller that streams a partially
    /// downloaded file can wait until these bytes are present before decoding.
    #[napi]
    pub fn next_sample_range<'env>(&self, env: &'env Env) -> Result<Object<'env>> {
        let guard = self.inner.lock().map_err(|_| lock_error())?;
        let inner = &*guard;
        let reader = inner.reader.as_ref().ok_or_else(lock_error)?;
        let mut range = Object::new(env)?;
        let index = reader.position();
        if index < inner.frame_count {
            let sample = &reader.track().samples()[index];
            let end = sample.end().map_err(container_error)?;
            range.set("done", false)?;
            range.set("start", sample.offset as f64)?;
            range.set("end", end as f64)?;
        } else {
            range.set("done", true)?;
            range.set("start", 0.0)?;
            range.set("end", 0.0)?;
        }
        Ok(range)
    }

    /// Byte range the next [`decodeNext`] call will read from the file. After
    /// a seek this spans the discarded warm-up frames plus the returned frame,
    /// so a streaming caller can wait until the whole window is downloaded
    /// before decoding (never reading through zero-filled holes).
    #[napi]
    pub fn decode_window_range<'env>(&self, env: &'env Env) -> Result<Object<'env>> {
        let guard = self.inner.lock().map_err(|_| lock_error())?;
        let inner = &*guard;
        let reader = inner.reader.as_ref().ok_or_else(lock_error)?;
        let mut range = Object::new(env)?;
        let index = reader.position();
        if index < inner.frame_count {
            let samples = reader.track().samples();
            let last = inner
                .discard_until
                .max(index)
                .min(inner.frame_count.saturating_sub(1));
            let start = samples[index].offset;
            let end = samples[last].end().map_err(container_error)?;
            range.set("done", false)?;
            range.set("start", start as f64)?;
            range.set("end", end as f64)?;
        } else {
            range.set("done", true)?;
            range.set("start", 0.0)?;
            range.set("end", 0.0)?;
        }
        Ok(range)
    }

    /// Decode the next frame to interleaved little-endian PCM16. Returns an
    /// object with `done: true` once the end of the track is reached.
    #[napi]
    pub fn decode_next<'env>(&self, env: &'env Env) -> Result<Object<'env>> {
        let mut guard = self.inner.lock().map_err(|_| lock_error())?;
        let inner = &mut *guard;

        loop {
            let next = {
                let reader = inner.reader.as_mut().ok_or_else(lock_error)?;
                reader.next_frame().map_err(container_error)?
            };
            let Some(frame) = next else {
                return done_frame(env, inner.frame_count as f64);
            };
            let frame_index = {
                let reader = inner.reader.as_ref().ok_or_else(lock_error)?;
                reader.position() - 1
            };

            if inner.decoder.is_none() {
                let decoder = BuiltinDecoder::configure(frame.header()).map_err(decode_error)?;
                inner.decoder = Some(decoder);
            }
            let decoder = inner.decoder.as_mut().expect("decoder is set above");
            let sample_count = decoder.sample_count().map_err(decode_error)?;
            if inner.pcm.len() != sample_count {
                inner.pcm.resize(sample_count, 0);
            }
            decoder
                .decode_into(&frame, &mut inner.pcm)
                .map_err(decode_error)?;

            if frame_index < inner.discard_until {
                continue;
            }

            let config = decoder.config();
            return pcm_frame(
                env,
                &inner.pcm,
                frame_index as f64,
                f64::from(config.sample_rate),
                f64::from(config.channels),
            );
        }
    }

    /// Release the underlying file handle. Safe to call more than once; any
    /// further method call returns an error.
    #[napi]
    pub fn close(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.reader = None;
            inner.decoder = None;
            inner.pcm.clear();
        }
    }
}

fn done_frame<'env>(env: &'env Env, frame_count: f64) -> Result<Object<'env>> {
    let mut result = Object::new(env)?;
    result.set("done", true)?;
    result.set("data", Null.into_unknown(env)?)?;
    result.set("frameIndex", frame_count)?;
    result.set("sampleRate", 0.0)?;
    result.set("channels", 0.0)?;
    Ok(result)
}

fn pcm_frame<'env>(
    env: &'env Env,
    samples: &[i16],
    frame_index: f64,
    sample_rate: f64,
    channels: f64,
) -> Result<Object<'env>> {
    let mut bytes = Vec::with_capacity(samples.len() * 2);
    for sample in samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    // NB: `ArrayBuffer::copy_from` in napi 3.12 allocates a zeroed buffer and
    // never copies the source bytes (regression); `from_data` actually
    // populates the buffer (external zero-copy, with a plain copy fallback).
    let data = ArrayBuffer::from_data(env, bytes)?.into_unknown(env)?;
    let mut result = Object::new(env)?;
    result.set("done", false)?;
    result.set("data", data)?;
    result.set("frameIndex", frame_index)?;
    result.set("sampleRate", sample_rate)?;
    result.set("channels", channels)?;
    Ok(result)
}
