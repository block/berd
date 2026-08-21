#ifndef BERD_SIRI_TTS_BRIDGE_H
#define BERD_SIRI_TTS_BRIDGE_H

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/// Returns a malloc-owned JSON array of Siri voices for the requested language
/// prefix. Each item contains name, language, sizeBytes, and installed. Returns
/// NULL and sets error_out on failure.
char *berd_siri_tts_catalog_json(const char *language_prefix, char **error_out);

/// Returns the locale tags represented in the complete Siri voice catalog.
/// This does not perform per-voice daemon validation.
char *berd_siri_tts_languages_json(char **error_out);

/// Downloads and validates one exact Siri voice. This call blocks until the
/// voice is usable or the timeout elapses.
bool berd_siri_tts_download_voice(
    const char *language,
    const char *voice_name,
    double timeout_seconds,
    char **error_out
);

typedef bool (*BerdSiriTTSShouldStop)(void *context);
typedef void (*BerdSiriTTSPlaybackStarted)(void *context);

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
    void *context,
    char **error_out
);
bool berd_siri_tts_stream_enqueue(void *stream, const char *text, char **error_out);
void berd_siri_tts_stream_finish(void *stream);
bool berd_siri_tts_stream_is_finished(void *stream);
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

/// Frees strings returned by this bridge.
void berd_siri_tts_free_string(char *value);

#ifdef __cplusplus
}
#endif

#endif
