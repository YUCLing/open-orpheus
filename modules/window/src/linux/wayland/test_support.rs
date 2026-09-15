//! Wire-format helpers shared by the Wayland test modules.
//!
//! Every module that drives the pipeline needs to encode Wayland messages, and
//! until now each carried its own copy of the encoder — which is how the same
//! size-field bug had to be fixed twice. The encoders live here now, named by
//! what they are for, so the wire format is written down once.

use super::codec::WlMessage;

/// Round `len` up to the next multiple of 4, the Wayland word size.
pub(crate) fn padded_len(len: usize) -> usize {
    len.next_multiple_of(4)
}

/// An 8-byte header whose size field claims `size` **bytes**.
///
/// Bytes, not 4-byte units: that is X11's convention, not Wayland's.
pub(crate) fn header(object_id: u32, opcode: u16, size: usize) -> [u8; 8] {
    let mut buf = [0u8; 8];
    buf[..4].copy_from_slice(&object_id.to_ne_bytes());
    buf[4..].copy_from_slice(&(((size as u32) << 16) | opcode as u32).to_ne_bytes());
    buf
}

/// A complete message: header plus `args`, padded to a 4-byte boundary.
pub(crate) fn message_bytes(object_id: u32, opcode: u16, args: &[u8]) -> Vec<u8> {
    // The header describes the *padded* length, so the body has to be padded
    // before the header can be written.
    let len = padded_len(8 + args.len());
    let mut buf = Vec::with_capacity(len);
    buf.extend_from_slice(&header(object_id, opcode, len));
    buf.extend_from_slice(args);
    buf.resize(len, 0);
    buf
}

/// [`message_bytes`] as the decoder would hand it to a handler.
pub(crate) fn message(object_id: u32, opcode: u16, args: &[u8]) -> WlMessage {
    WlMessage::new(object_id, opcode, message_bytes(object_id, opcode, args))
}

/// A message whose header claims `size` bytes and whose buffer is exactly that
/// long — including sizes no real message may use, which is the point.
pub(crate) fn declared_message(object_id: u32, opcode: u16, size: usize) -> Vec<u8> {
    let mut buf = header(object_id, opcode, size).to_vec();
    buf.resize(size, 0);
    buf
}

/// A `size`-byte message with word arguments, for asserting the exact bytes an
/// injection wrote. The caller states the size, so it can express the
/// expectation before the code under test reads the header.
pub(crate) fn request(object_id: u32, opcode: u16, size: usize, args: &[u32]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(size);
    buf.extend_from_slice(&header(object_id, opcode, size));
    for arg in args {
        buf.extend_from_slice(&arg.to_ne_bytes());
    }
    buf
}

/// A 32-bit argument.
pub(crate) fn word(value: u32) -> Vec<u8> {
    value.to_ne_bytes().to_vec()
}

/// A wire-format string: its length *including* the NUL terminator, the bytes,
/// the terminator, then zero padding.
pub(crate) fn wl_string(text: &str) -> Vec<u8> {
    let mut body = text.as_bytes().to_vec();
    body.push(0);

    let mut buf = word(body.len() as u32);
    buf.extend_from_slice(&body);
    buf.resize(padded_len(buf.len()), 0);
    buf
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_message_is_padded_and_described_by_its_padded_length() {
        let padded = message_bytes(3, 1, &[1, 2, 3]);

        assert_eq!(padded.len(), 12, "8 + 3 rounds up to 12");
        assert_eq!(padded[11], 0, "the tail is zero padding");
        assert_eq!(
            u16::from_ne_bytes([padded[6], padded[7]]),
            12,
            "the size field counts the padded length in bytes"
        );
    }

    #[test]
    fn a_string_length_counts_its_nul_terminator() {
        let aligned = wl_string("wlp");
        assert_eq!(
            u32::from_ne_bytes(aligned[..4].try_into().expect("4 bytes")),
            4,
            "3 characters plus the terminator"
        );
        assert_eq!(aligned.len(), 8, "4 + 3 + 1 already ends on a word");

        let padded = wl_string("wl");
        assert_eq!(
            u32::from_ne_bytes(padded[..4].try_into().expect("4 bytes")),
            3,
            "2 characters plus the terminator"
        );
        assert_eq!(padded.len(), 8, "4 + 2 + 1 rounds up to 8");
        assert_eq!(padded[7], 0, "the padding is zeroed");
    }
}
