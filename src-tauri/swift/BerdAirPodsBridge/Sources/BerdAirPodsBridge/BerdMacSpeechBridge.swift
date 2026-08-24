@preconcurrency import AVFoundation
import Darwin
import Foundation
@preconcurrency import Speech

// Stable event values consumed by the Rust bridge.
private let finalEvent: Int32 = 1
private let finishedEvent: Int32 = 2
private let failedEvent: Int32 = 3

public typealias BerdMacSpeechEventCallback = @convention(c) (
    Int32, UnsafePointer<CChar>?, UnsafeMutableRawPointer?
) -> Void
public typealias BerdMacSpeechProgressCallback = @convention(c) (
    Double, UnsafeMutableRawPointer?
) -> Void

private struct CallbackContext: @unchecked Sendable {
    let pointer: UnsafeMutableRawPointer?
}

private final class ConverterInput: @unchecked Sendable {
    let buffer: AVAudioPCMBuffer
    var supplied = false

    init(_ buffer: AVAudioPCMBuffer) { self.buffer = buffer }
}

private enum BridgeError: LocalizedError {
    case missingResult
    case unsupportedSystem
    case unsupportedLocale(String)
    case modelUnavailable(String)
    case invalidAudio
    case conversion(String)
    case inputClosed
    case inputOverrun
    case statusTimedOut
    case finishTimedOut

    var errorDescription: String? {
        switch self {
        case .missingResult: "The macOS speech operation ended without a result."
        case .unsupportedSystem: "macOS speech recognition requires macOS 26 or later."
        case .unsupportedLocale(let locale): "macOS speech recognition does not support \(locale)."
        case .modelUnavailable(let locale): "The on-device speech model for \(locale) is not installed."
        case .invalidAudio: "macOS speech input must be non-empty mono Float32 PCM."
        case .conversion(let detail): "Could not convert macOS speech input: \(detail)"
        case .inputClosed: "The macOS speech input stream is closed."
        case .inputOverrun: "macOS speech recognition could not keep up with microphone input."
        case .statusTimedOut: "Apple speech recognition status did not respond before its deadline."
        case .finishTimedOut: "macOS speech recognition did not finish before its deadline."
        }
    }
}

private final class ResultBox<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var result: Result<Value, Error>?

    func store(_ result: Result<Value, Error>) { lock.withLock { self.result = result } }
    func take() throws -> Value {
        try lock.withLock {
            guard let result else { throw BridgeError.missingResult }
            return try result.get()
        }
    }
}

private func wait<Value>(
    _ operation: @escaping @Sendable () async throws -> Value
) throws -> Value {
    let semaphore = DispatchSemaphore(value: 0)
    let box = ResultBox<Value>()
    Task.detached {
        do { box.store(.success(try await operation())) }
        catch { box.store(.failure(error)) }
        semaphore.signal()
    }
    semaphore.wait()
    return try box.take()
}

private func wait<Value>(
    until deadline: DispatchTime,
    timeoutError: BridgeError,
    _ operation: @escaping @Sendable () async throws -> Value
) throws -> Value {
    let semaphore = DispatchSemaphore(value: 0)
    let box = ResultBox<Value>()
    Task.detached {
        do { box.store(.success(try await operation())) }
        catch { box.store(.failure(error)) }
        semaphore.signal()
    }
    guard semaphore.wait(timeout: deadline) == .success else {
        throw timeoutError
    }
    return try box.take()
}

private func locale(from identifier: UnsafePointer<CChar>?) -> Locale {
    guard let identifier else { return .current }
    let value = String(cString: identifier)
    return value.isEmpty ? .current : Locale(identifier: value)
}

private func setError(
    _ output: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?,
    _ message: String
) {
    output?.pointee = strdup(message)
}

private struct SpeechStatus: Encodable {
    let supported: Bool
    let locale: String?
    let localeSupported: Bool
    let modelStatus: String
    let ready: Bool
}

@available(macOS 26.0, *)
private func resolve(_ requested: Locale) async -> Locale? {
    await SpeechTranscriber.supportedLocale(equivalentTo: requested)
}

@available(macOS 26.0, *)
private func speechTranscriber(for locale: Locale) -> SpeechTranscriber {
    SpeechTranscriber(
        locale: locale,
        transcriptionOptions: [],
        reportingOptions: [],
        attributeOptions: [.audioTimeRange]
    )
}

@available(macOS 26.0, *)
private func assetModules(for locale: Locale) -> [any SpeechModule] {
    [speechTranscriber(for: locale)]
}

@available(macOS 26.0, *)
private func describe(_ status: AssetInventory.Status) -> String {
    switch status {
    case .unsupported: "unsupported"
    case .supported: "available"
    case .downloading: "downloading"
    case .installed: "installed"
    @unknown default: "unknown"
    }
}

@available(macOS 26.0, *)
private func status(for requested: Locale) async -> SpeechStatus {
    guard SpeechTranscriber.isAvailable else {
        return SpeechStatus(
            supported: false, locale: nil, localeSupported: false,
            modelStatus: "unsupported", ready: false
        )
    }
    guard let locale = await resolve(requested) else {
        return SpeechStatus(
            supported: true, locale: nil, localeSupported: false,
            modelStatus: "unsupported", ready: false
        )
    }
    let transcriber = speechTranscriber(for: locale)
    let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber])
    let inventory = await AssetInventory.status(forModules: assetModules(for: locale))
    let ready = format != nil
    return SpeechStatus(
        supported: true,
        locale: locale.identifier(.bcp47),
        localeSupported: true,
        modelStatus: ready ? "installed" : describe(inventory),
        ready: ready
    )
}

@available(macOS 26.0, *)
private func installModel(
    for requested: Locale,
    progress: BerdMacSpeechProgressCallback?,
    context: CallbackContext
) async throws {
    guard let locale = await resolve(requested) else {
        throw BridgeError.unsupportedLocale(requested.identifier(.bcp47))
    }
    let modules = assetModules(for: locale)
    if await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: modules) != nil {
        progress?(1, context.pointer)
        return
    }
    let initial = await AssetInventory.status(forModules: modules)
    if initial == .installed {
        progress?(1, context.pointer)
        return
    }
    guard initial != .unsupported else {
        throw BridgeError.modelUnavailable(locale.identifier(.bcp47))
    }
    if let request = try await AssetInventory.assetInstallationRequest(supporting: modules) {
        let progressTask = Task {
            while !Task.isCancelled {
                progress?(request.progress.fractionCompleted, context.pointer)
                try? await Task.sleep(for: .milliseconds(250))
            }
        }
        do {
            try await request.downloadAndInstall()
        } catch {
            progressTask.cancel()
            await progressTask.value
            throw error
        }
        progressTask.cancel()
        await progressTask.value
    }
    guard await AssetInventory.status(forModules: modules) == .installed else {
        throw BridgeError.modelUnavailable(locale.identifier(.bcp47))
    }
    progress?(1, context.pointer)
}

@available(macOS 26.0, *)
private final class SpeechSession: @unchecked Sendable {
    private let callback: BerdMacSpeechEventCallback
    private let context: CallbackContext
    private let analyzer: SpeechAnalyzer
    private let transcriber: SpeechTranscriber
    private let targetFormat: AVAudioFormat
    private let input: AsyncStream<AnalyzerInput>
    private let continuation: AsyncStream<AnalyzerInput>.Continuation
    private let lock = NSLock()
    private let completion = DispatchSemaphore(value: 0)
    private var converter: AVAudioConverter?
    private var converterSource: AVAudioFormat?
    private var inputFinished = false
    private var callbacksEnabled = true
    private var terminalEmitted = false
    private var completedTasks = 0
    private var tasks: [Task<Void, Never>] = []

    static func make(
        requestedLocale: Locale,
        callback: @escaping BerdMacSpeechEventCallback,
        context: CallbackContext
    ) async throws -> SpeechSession {
        guard let locale = await resolve(requestedLocale) else {
            throw BridgeError.unsupportedLocale(requestedLocale.identifier(.bcp47))
        }
        let transcriber = speechTranscriber(for: locale)
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
            throw BridgeError.modelUnavailable(locale.identifier(.bcp47))
        }
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        let (input, continuation) = AsyncStream<AnalyzerInput>.makeStream(
            bufferingPolicy: .bufferingOldest(64)
        )
        let session = SpeechSession(
            callback: callback, context: context, analyzer: analyzer,
            transcriber: transcriber, targetFormat: format,
            input: input, continuation: continuation
        )
        session.start()
        return session
    }

    private init(
        callback: @escaping BerdMacSpeechEventCallback,
        context: CallbackContext,
        analyzer: SpeechAnalyzer,
        transcriber: SpeechTranscriber,
        targetFormat: AVAudioFormat,
        input: AsyncStream<AnalyzerInput>,
        continuation: AsyncStream<AnalyzerInput>.Continuation
    ) {
        self.callback = callback
        self.context = context
        self.analyzer = analyzer
        self.transcriber = transcriber
        self.targetFormat = targetFormat
        self.input = input
        self.continuation = continuation
    }

    private func start() {
        tasks = [
            Task.detached { [weak self, analyzer, input] in
                do {
                    _ = try await analyzer.analyzeSequence(input)
                    self?.taskCompleted()
                } catch is CancellationError { self?.taskCompleted() }
                catch { self?.taskCompleted(error: error) }
            },
            Task.detached { [weak self, transcriber] in
                do {
                    for try await result in transcriber.results {
                        guard let self else { return }
                        let text = String(result.text.characters)
                            .trimmingCharacters(in: .whitespacesAndNewlines)
                        guard !text.isEmpty else { continue }
                        guard result.isFinal else { continue }
                        self.emit(finalEvent, text: text)
                    }
                    self?.taskCompleted()
                } catch is CancellationError { self?.taskCompleted() }
                catch { self?.taskCompleted(error: error) }
            },
        ]
    }

    func push(samples: UnsafePointer<Float>, count: Int, sampleRate: Double) throws {
        guard count > 0, sampleRate > 0 else { throw BridgeError.invalidAudio }
        try lock.withLock {
            guard !inputFinished else { throw BridgeError.inputClosed }
            guard let sourceFormat = AVAudioFormat(
                commonFormat: .pcmFormatFloat32, sampleRate: sampleRate,
                channels: 1, interleaved: false
            ), let source = AVAudioPCMBuffer(
                pcmFormat: sourceFormat, frameCapacity: AVAudioFrameCount(count)
            ), let channel = source.floatChannelData?[0] else {
                throw BridgeError.invalidAudio
            }
            source.frameLength = AVAudioFrameCount(count)
            channel.update(from: samples, count: count)

            let output: AVAudioPCMBuffer
            if sourceFormat == targetFormat {
                output = source
            } else {
                if converter == nil || converterSource != sourceFormat {
                    converter = AVAudioConverter(from: sourceFormat, to: targetFormat)
                    converterSource = sourceFormat
                }
                guard let converter else { throw BridgeError.conversion("no compatible converter") }
                let capacity = AVAudioFrameCount(
                    ceil(Double(count) * targetFormat.sampleRate / sampleRate) + 32
                )
                guard let converted = AVAudioPCMBuffer(
                    pcmFormat: targetFormat, frameCapacity: capacity
                ) else { throw BridgeError.conversion("could not allocate output buffer") }
                let converterInput = ConverterInput(source)
                var conversionError: NSError?
                let conversionStatus = converter.convert(to: converted, error: &conversionError) {
                    _, status in
                    if converterInput.supplied {
                        status.pointee = .noDataNow
                        return nil
                    }
                    converterInput.supplied = true
                    status.pointee = .haveData
                    return converterInput.buffer
                }
                if let conversionError { throw BridgeError.conversion(conversionError.localizedDescription) }
                guard conversionStatus != .error, converted.frameLength > 0 else {
                    throw BridgeError.conversion("the converter produced no audio")
                }
                output = converted
            }
            switch continuation.yield(AnalyzerInput(buffer: output)) {
            case .enqueued: return
            case .dropped: throw BridgeError.inputOverrun
            case .terminated: throw BridgeError.inputClosed
            @unknown default: throw BridgeError.inputClosed
            }
        }
    }

    func finish(timeout: TimeInterval) throws {
        let deadline = DispatchTime.now() + max(timeout, 0)
        let shouldFinish = try lock.withLock {
            guard !inputFinished else { return false }
            inputFinished = true
            do {
                try drainConverter()
            } catch {
                continuation.finish()
                throw error
            }
            continuation.finish()
            return true
        }
        guard shouldFinish else { return }
        do {
            try wait(until: deadline, timeoutError: .finishTimedOut) {
                [analyzer] in try await analyzer.finalizeAndFinishThroughEndOfInput()
            }
        } catch {
            fail(error)
            cancel()
            throw error
        }
        guard completion.wait(timeout: deadline) == .success else {
            cancel()
            throw BridgeError.finishTimedOut
        }
    }

    func cancel() {
        let currentTasks = lock.withLock {
            callbacksEnabled = false
            if !inputFinished {
                inputFinished = true
                continuation.finish()
            }
            return tasks
        }
        currentTasks.forEach { $0.cancel() }
        Task.detached { [analyzer] in await analyzer.cancelAndFinishNow() }
    }

    private func emit(_ event: Int32, text: String? = nil) {
        lock.withLock {
            guard callbacksEnabled, !terminalEmitted else { return }
            if let text { text.withCString { callback(event, $0, context.pointer) } }
            else { callback(event, nil, context.pointer) }
        }
    }

    private func fail(_ error: Error) {
        let emitted = lock.withLock {
            guard callbacksEnabled, !terminalEmitted else { return false }
            terminalEmitted = true
            error.localizedDescription.withCString { callback(failedEvent, $0, context.pointer) }
            return true
        }
        if emitted { completion.signal() }
    }

    private func taskCompleted(error: Error? = nil) {
        if let error {
            fail(error)
            return
        }
        let emitted = lock.withLock {
            completedTasks += 1
            guard completedTasks == 2, callbacksEnabled, !terminalEmitted else { return false }
            terminalEmitted = true
            callback(finishedEvent, nil, context.pointer)
            return true
        }
        if emitted { completion.signal() }
    }

    private func drainConverter() throws {
        guard let converter else { return }
        for _ in 0..<4 {
            guard let output = AVAudioPCMBuffer(
                pcmFormat: targetFormat, frameCapacity: 256
            ) else { throw BridgeError.conversion("could not allocate tail buffer") }
            var conversionError: NSError?
            let status = converter.convert(to: output, error: &conversionError) { _, inputStatus in
                inputStatus.pointee = .endOfStream
                return nil
            }
            if let conversionError { throw BridgeError.conversion(conversionError.localizedDescription) }
            if output.frameLength > 0 {
                guard case .enqueued = continuation.yield(AnalyzerInput(buffer: output)) else {
                    throw BridgeError.inputOverrun
                }
            }
            if status != .haveData { break }
        }
    }
}

@_cdecl("berd_macos_stt_is_supported")
public func berdMacSTTIsSupported() -> Bool {
    if #available(macOS 26.0, *) { return SpeechTranscriber.isAvailable }
    return false
}

@_cdecl("berd_macos_stt_status_json")
public func berdMacSTTStatusJSON(
    _ identifier: UnsafePointer<CChar>?,
    _ errorOut: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> UnsafeMutablePointer<CChar>? {
    errorOut?.pointee = nil
    let requested = locale(from: identifier)
    let value: SpeechStatus
    if #available(macOS 26.0, *) {
        do {
            value = try wait(
                until: .now() + 5,
                timeoutError: .statusTimedOut
            ) { await status(for: requested) }
        }
        catch {
            setError(errorOut, error.localizedDescription)
            return nil
        }
    } else {
        value = SpeechStatus(
            supported: false, locale: nil, localeSupported: false,
            modelStatus: "unsupported", ready: false
        )
    }
    do {
        let data = try JSONEncoder().encode(value)
        guard let string = String(data: data, encoding: .utf8) else {
            throw BridgeError.missingResult
        }
        return string.withCString { strdup($0) }
    } catch {
        setError(errorOut, error.localizedDescription)
        return nil
    }
}

@_cdecl("berd_macos_stt_install_model")
public func berdMacSTTInstallModel(
    _ identifier: UnsafePointer<CChar>?,
    _ progress: BerdMacSpeechProgressCallback?,
    _ context: UnsafeMutableRawPointer?,
    _ errorOut: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Bool {
    errorOut?.pointee = nil
    guard #available(macOS 26.0, *) else {
        setError(errorOut, BridgeError.unsupportedSystem.localizedDescription)
        return false
    }
    let requested = locale(from: identifier)
    let callbackContext = CallbackContext(pointer: context)
    do {
        try wait {
            try await installModel(
                for: requested, progress: progress, context: callbackContext
            )
        }
        return true
    } catch {
        setError(errorOut, error.localizedDescription)
        return false
    }
}

@_cdecl("berd_macos_stt_create")
public func berdMacSTTCreate(
    _ identifier: UnsafePointer<CChar>?,
    _ callback: BerdMacSpeechEventCallback?,
    _ context: UnsafeMutableRawPointer?,
    _ errorOut: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> UnsafeMutableRawPointer? {
    errorOut?.pointee = nil
    guard #available(macOS 26.0, *) else {
        setError(errorOut, BridgeError.unsupportedSystem.localizedDescription)
        return nil
    }
    guard let callback else {
        setError(errorOut, "A macOS speech event callback is required.")
        return nil
    }
    let requested = locale(from: identifier)
    let callbackContext = CallbackContext(pointer: context)
    do {
        let session = try wait {
            try await SpeechSession.make(
                requestedLocale: requested, callback: callback, context: callbackContext
            )
        }
        return Unmanaged.passRetained(session).toOpaque()
    } catch {
        setError(errorOut, error.localizedDescription)
        return nil
    }
}

@_cdecl("berd_macos_stt_push")
public func berdMacSTTPush(
    _ handle: UnsafeMutableRawPointer?, _ samples: UnsafePointer<Float>?,
    _ count: Int, _ sampleRate: Double,
    _ errorOut: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Bool {
    errorOut?.pointee = nil
    guard #available(macOS 26.0, *), let handle, let samples else {
        setError(errorOut, BridgeError.invalidAudio.localizedDescription)
        return false
    }
    do {
        try Unmanaged<SpeechSession>.fromOpaque(handle).takeUnretainedValue()
            .push(samples: samples, count: count, sampleRate: sampleRate)
        return true
    } catch {
        setError(errorOut, error.localizedDescription)
        return false
    }
}

@_cdecl("berd_macos_stt_finish")
public func berdMacSTTFinish(
    _ handle: UnsafeMutableRawPointer?, _ timeoutSeconds: Double,
    _ errorOut: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Bool {
    errorOut?.pointee = nil
    guard #available(macOS 26.0, *), let handle else {
        setError(errorOut, BridgeError.unsupportedSystem.localizedDescription)
        return false
    }
    do {
        try Unmanaged<SpeechSession>.fromOpaque(handle).takeUnretainedValue()
            .finish(timeout: timeoutSeconds)
        return true
    } catch {
        setError(errorOut, error.localizedDescription)
        return false
    }
}

@_cdecl("berd_macos_stt_cancel")
public func berdMacSTTCancel(_ handle: UnsafeMutableRawPointer?) {
    guard #available(macOS 26.0, *), let handle else { return }
    Unmanaged<SpeechSession>.fromOpaque(handle).takeUnretainedValue().cancel()
}

@_cdecl("berd_macos_stt_release")
public func berdMacSTTRelease(_ handle: UnsafeMutableRawPointer?) {
    guard #available(macOS 26.0, *), let handle else { return }
    let session = Unmanaged<SpeechSession>.fromOpaque(handle).takeRetainedValue()
    session.cancel()
}

@_cdecl("berd_macos_stt_free_string")
public func berdMacSTTFreeString(_ value: UnsafeMutablePointer<CChar>?) { free(value) }
