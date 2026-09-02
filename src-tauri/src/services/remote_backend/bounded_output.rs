//! Allocation-bounded byte-to-line parsing for untrusted SSH output.
//!
//! `tokio::io::AsyncBufReadExt::lines` buffers until a newline before returning,
//! so a remote peer controls the size of that allocation. This module reads
//! fixed chunks and checks every byte budget before extending retained state.

use tokio::io::{AsyncRead, AsyncReadExt};

const READ_CHUNK_BYTES: usize = 8 * 1024;

#[derive(Clone, Copy, Debug)]
pub(crate) struct LineLimits {
    pub max_line_bytes: usize,
    pub max_stream_bytes: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LineLimitKind {
    LineBytes,
    StreamBytes,
    ProtocolRecords,
    RetainedBytes,
    ProtocolEncoding,
}

#[derive(Debug)]
pub(crate) enum BoundedLineError {
    Io(std::io::Error),
    Limit(LineLimitKind),
}

impl std::fmt::Display for BoundedLineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(f, "read failed: {error}"),
            Self::Limit(LineLimitKind::LineBytes) => write!(f, "line byte limit exceeded"),
            Self::Limit(LineLimitKind::StreamBytes) => write!(f, "stream byte limit exceeded"),
            Self::Limit(LineLimitKind::ProtocolRecords) => {
                write!(f, "protocol record limit exceeded")
            }
            Self::Limit(LineLimitKind::RetainedBytes) => {
                write!(f, "retained byte limit exceeded")
            }
            Self::Limit(LineLimitKind::ProtocolEncoding) => {
                write!(f, "protocol record is not valid UTF-8")
            }
        }
    }
}

impl std::error::Error for BoundedLineError {}

/// Read `reader` as newline-delimited bytes and call `on_line` for each line.
///
/// Lines exclude the LF delimiter and one optional preceding CR. A final
/// unterminated line is delivered at EOF. Input is not converted to UTF-8 until
/// after both the per-line and cumulative stream budgets have been enforced.
pub(crate) async fn read_bounded_lines<R, F>(
    mut reader: R,
    limits: LineLimits,
    mut on_line: F,
) -> Result<(), BoundedLineError>
where
    R: AsyncRead + Unpin,
    F: FnMut(&[u8]) -> Result<(), BoundedLineError>,
{
    read_bounded_lines_with_chunk_size(&mut reader, limits, READ_CHUNK_BYTES, &mut on_line).await
}

async fn read_bounded_lines_with_chunk_size<R, F>(
    reader: &mut R,
    limits: LineLimits,
    chunk_bytes: usize,
    on_line: &mut F,
) -> Result<(), BoundedLineError>
where
    R: AsyncRead + Unpin,
    F: FnMut(&[u8]) -> Result<(), BoundedLineError>,
{
    let mut chunk = vec![0_u8; chunk_bytes.clamp(1, READ_CHUNK_BYTES)];
    let mut line = Vec::with_capacity(limits.max_line_bytes.min(READ_CHUNK_BYTES));
    let mut stream_bytes = 0_usize;

    loop {
        let read = reader
            .read(&mut chunk)
            .await
            .map_err(BoundedLineError::Io)?;
        if read == 0 {
            if !line.is_empty() {
                on_line(strip_cr(&line))?;
            }
            return Ok(());
        }

        stream_bytes = stream_bytes
            .checked_add(read)
            .filter(|total| *total <= limits.max_stream_bytes)
            .ok_or(BoundedLineError::Limit(LineLimitKind::StreamBytes))?;

        let mut start = 0;
        for (index, byte) in chunk[..read].iter().enumerate() {
            if *byte != b'\n' {
                continue;
            }
            extend_line(&mut line, &chunk[start..index], limits.max_line_bytes)?;
            on_line(strip_cr(&line))?;
            line.clear();
            start = index + 1;
        }
        extend_line(&mut line, &chunk[start..read], limits.max_line_bytes)?;
    }
}

fn extend_line(
    line: &mut Vec<u8>,
    bytes: &[u8],
    max_line_bytes: usize,
) -> Result<(), BoundedLineError> {
    line.len()
        .checked_add(bytes.len())
        .filter(|total| *total <= max_line_bytes)
        .ok_or(BoundedLineError::Limit(LineLimitKind::LineBytes))?;
    line.extend_from_slice(bytes);
    Ok(())
}

fn strip_cr(line: &[u8]) -> &[u8] {
    line.strip_suffix(b"\r").unwrap_or(line)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn rejects_oversized_unterminated_line_before_growing_past_limit() {
        let input = vec![b'x'; 65];
        let mut delivered = Vec::new();
        let error = read_bounded_lines(
            input.as_slice(),
            LineLimits {
                max_line_bytes: 64,
                max_stream_bytes: 1_024,
            },
            |line| {
                delivered.push(line.to_vec());
                Ok(())
            },
        )
        .await
        .unwrap_err();

        assert!(matches!(
            error,
            BoundedLineError::Limit(LineLimitKind::LineBytes)
        ));
        assert!(delivered.is_empty());
    }

    #[tokio::test]
    async fn rejects_many_small_lines_at_the_cumulative_stream_limit() {
        let input = b"a\nb\nc\nd\n";
        let mut delivered = 0;
        let error = read_bounded_lines(
            input.as_slice(),
            LineLimits {
                max_line_bytes: 8,
                max_stream_bytes: input.len() - 1,
            },
            |_| {
                delivered += 1;
                Ok(())
            },
        )
        .await
        .unwrap_err();

        assert!(matches!(
            error,
            BoundedLineError::Limit(LineLimitKind::StreamBytes)
        ));
        assert_eq!(delivered, 0, "the single read is rejected before parsing");
    }

    #[tokio::test]
    async fn preserves_utf8_split_across_fixed_reads() {
        let input = b"a\xc3\xa9\n";
        let mut reader = input.as_slice();
        let mut lines = Vec::new();
        read_bounded_lines_with_chunk_size(
            &mut reader,
            LineLimits {
                max_line_bytes: 8,
                max_stream_bytes: 16,
            },
            2,
            &mut |line| {
                lines.push(String::from_utf8(line.to_vec()).unwrap());
                Ok(())
            },
        )
        .await
        .unwrap();

        assert_eq!(lines, ["aé"]);
    }
}
