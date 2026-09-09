#ifndef BERD_SIRI_TTS_BRIDGE_H
#define BERD_SIRI_TTS_BRIDGE_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/// Returns a malloc-owned JSON array of Siri voices for the requested exact
/// normalized language, or every language when empty. Each item contains name,
/// language, sizeBytes, and installed. Returns NULL and sets error_out on failure.
char *berd_siri_tts_catalog_json(const char *language, char **error_out);

/// Returns the locale tags represented in the complete Siri voice catalog.
/// This does not perform per-voice daemon validation.
char *berd_siri_tts_languages_json(char **error_out);

/// Downloads and validates one exact Siri voice. This call blocks until the
/// voice is usable or the availability-polling timeout elapses. Validation and
/// subscription are separately bounded and occur before that polling deadline.
bool berd_siri_tts_download_voice(
    const char *language,
    const char *voice_name,
    double timeout_seconds,
    char **error_out
);

typedef bool (*BerdSiriTTSShouldStop)(void *context);
typedef void (*BerdSiriTTSPlaybackStarted)(void *context);
typedef bool (*BerdSiriTTSPcmFrames)(
    const float *samples,
    uint32_t frame_count,
    void *context
);

/// Validates that an exact Siri voice is downloaded and usable through
/// sirittsd. This does not synthesize or play audio.
bool berd_siri_tts_validate_voice(
    const char *language,
    const char *voice_name,
    char **error_out
);

/// Synthesizes one utterance and emits normalized 48 kHz mono Float32 PCM.
/// This call blocks until synthesis and converter flushing complete. It never
/// opens an audio device. Returning false from `pcm_frames` cancels synthesis.
bool berd_siri_tts_synthesize_pcm(
    const char *text,
    const char *language,
    const char *voice_name,
    float rate,
    BerdSiriTTSShouldStop should_stop,
    BerdSiriTTSPcmFrames pcm_frames,
    void *context,
    char **error_out
);

/// Plays the small per-voice sample bundled with macOS. This works before the
/// full Siri voice has been downloaded.
bool berd_siri_tts_play_sample(
    const char *voice_name,
    const char *language,
    float rate,
    BerdSiriTTSShouldStop should_stop,
    void *context,
    char **error_out
);

/// Opaque streaming player. Text chunks are synthesized in order while
/// previously queued audio continues playing.
void *berd_siri_tts_stream_create(
    const char *language,
    const char *voice_name,
    float rate,
    BerdSiriTTSPlaybackStarted playback_started,
    BerdSiriTTSPlaybackStarted playback_stopped,
    void *context,
    char **error_out
);
bool berd_siri_tts_stream_enqueue(void *stream, const char *text, char **error_out);
void berd_siri_tts_stream_finish(void *stream);
bool berd_siri_tts_stream_is_finished(void *stream);
uint64_t berd_siri_tts_stream_progress(void *stream);
char *berd_siri_tts_stream_copy_delivery_json(void *stream);
char *berd_siri_tts_stream_copy_error(void *stream);
void berd_siri_tts_stream_cancel(void *stream);
void berd_siri_tts_stream_release(void *stream);

/// Synthesizes one utterance through sirittsd and streams its audio packets to
/// the default macOS output. This call blocks until playback completes.
bool berd_siri_tts_speak(
    const char *text,
    const char *language,
    const char *voice_name,
    float rate,
    BerdSiriTTSShouldStop should_stop,
    BerdSiriTTSPlaybackStarted playback_started,
    void *context,
    char **error_out
);

/// Opaque Pocket PCM player backed by AVAudioUnitTimePitch. Samples are
/// mono, noninterleaved float PCM. Device ID 0 uses the system default.
void *berd_pocket_audio_player_create(
    uint32_t sample_rate,
    float rate,
    uint32_t output_device_id,
    char **error_out
);
bool berd_pocket_audio_player_enqueue(
    void *player,
    const float *samples,
    uint32_t frame_count,
    char **error_out
);
uint64_t berd_pocket_audio_player_completed_source_frames(void *player);
uint64_t berd_pocket_audio_player_pending_buffers(void *player);
bool berd_pocket_audio_player_failed(void *player);
void berd_pocket_audio_player_stop(void *player);
void berd_pocket_audio_player_release(void *player);

/// Frees strings returned by this bridge.
void berd_siri_tts_free_string(char *value);

#ifdef __cplusplus
}
#endif

#endif
