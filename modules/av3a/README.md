# @open-orpheus/av3a

Native AV3A (AVS3-P3) decoder module for Open Orpheus, built with NAPI-RS over
the [`avs3a-rust`](https://github.com/1254qwer/avs3a-rust) decoder crate.

Currently only the **M4A / MP4 container** is supported: the module indexes the
AV3A track from the `moov` box and decodes samples in decode order to
interleaved little-endian PCM16.
