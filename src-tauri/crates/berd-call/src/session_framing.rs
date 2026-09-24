pub(crate) const SESSION_PROTOCOL_VERSION: u32 = 5;
pub(crate) const FRAME_MAGIC: [u8; 2] = *b"BV";
pub(crate) const FRAME_MARKER: u8 = 3;
pub(crate) const JSON_FRAME_KIND: u8 = 1;
pub(crate) const PCM_FRAME_KIND: u8 = 2;
pub(crate) const FRAME_HEADER_BYTES: usize = 8;

pub(crate) fn encode_frame(kind: u8, payload: &[u8]) -> Result<Vec<u8>, String> {
    let length = u32::try_from(payload.len()).map_err(|_| "voice session request is too large")?;
    let mut frame = Vec::with_capacity(FRAME_HEADER_BYTES + payload.len());
    frame.extend_from_slice(&FRAME_MAGIC);
    frame.push(FRAME_MARKER);
    frame.push(kind);
    frame.extend_from_slice(&length.to_le_bytes());
    frame.extend_from_slice(payload);
    Ok(frame)
}
