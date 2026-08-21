import AVFoundation
import Foundation

public typealias InputMuteCallback = @convention(c) (Bool) -> Void
public typealias AudioInputCallback = @convention(c) (UnsafePointer<Float>, Int) -> Void

@available(macOS 14.0, *)
private final class AirPodsMuteBridge: @unchecked Sendable {
    private let engine: AVAudioEngine
    private let inputNode: AVAudioInputNode
    private let callback: InputMuteCallback
    private let audioCallback: AudioInputCallback
    private let targetFormat: AVAudioFormat
    private let converter: AVAudioConverter?
    private var inputMuteObserver: NSObjectProtocol?

    init(
        callback: @escaping InputMuteCallback,
        audioCallback: @escaping AudioInputCallback
    ) throws {
        self.callback = callback
        self.audioCallback = audioCallback

        let engine = AVAudioEngine()
        let inputNode = engine.inputNode
        let inputFormat = inputNode.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else {
            throw BridgeError.noInputFormat
        }
        guard let targetFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: 48_000,
            channels: 1,
            interleaved: false
        ) else {
            throw BridgeError.noOutputFormat
        }
        let converter: AVAudioConverter?
        if inputFormat == targetFormat {
            converter = nil
        } else {
            guard let created = AVAudioConverter(from: inputFormat, to: targetFormat) else {
                throw BridgeError.noConverter
            }
            converter = created
        }
        self.engine = engine
        self.inputNode = inputNode
        self.targetFormat = targetFormat
        self.converter = converter

        inputNode.installTap(
            onBus: 0,
            bufferSize: 4096,
            format: inputFormat
        ) { [weak self] buffer, _ in
            self?.forward(buffer)
        }
        engine.prepare()
        try engine.start()

        // Clear stale process mute before registering this lifecycle's handler.
        // The reset can fail when no earlier handler exists, which is harmless.
        try? AVAudioApplication.shared.setInputMuted(false)
        try AVAudioApplication.shared.setInputMuteStateChangeHandler { [weak self] muted in
            self?.callback(muted)
            return true
        }
        inputMuteObserver = NotificationCenter.default.addObserver(
            forName: AVAudioApplication.inputMuteStateChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            guard let self else { return }
            self.callback(AVAudioApplication.shared.isInputMuted)
        }
    }

    func stop() {
        // Reset while the handler exists, then cancel the process-wide callback.
        try? AVAudioApplication.shared.setInputMuted(false)
        try? AVAudioApplication.shared.setInputMuteStateChangeHandler(nil)
        if let inputMuteObserver {
            NotificationCenter.default.removeObserver(inputMuteObserver)
            self.inputMuteObserver = nil
        }
        inputNode.removeTap(onBus: 0)
        engine.stop()
    }

    private func forward(_ source: AVAudioPCMBuffer) {
        let output: AVAudioPCMBuffer
        if let converter {
            let capacity = AVAudioFrameCount(ceil(
                Double(source.frameLength) * targetFormat.sampleRate / source.format.sampleRate
            ))
            guard capacity > 0,
                  let converted = AVAudioPCMBuffer(
                    pcmFormat: targetFormat,
                    frameCapacity: capacity
                  ) else { return }
            var error: NSError?
            nonisolated(unsafe) var consumed = false
            converter.convert(to: converted, error: &error) { _, status in
                if !consumed {
                    consumed = true
                    status.pointee = .haveData
                    return source
                }
                status.pointee = .noDataNow
                return nil
            }
            guard error == nil, converted.frameLength > 0 else { return }
            output = converted
        } else {
            output = source
        }
        guard let channel = output.floatChannelData?.pointee,
              output.frameLength > 0 else { return }
        audioCallback(channel, Int(output.frameLength))
    }

    private enum BridgeError: Error {
        case noInputFormat
        case noOutputFormat
        case noConverter
    }
}

@available(macOS 14.0, *)
private var activeBridge: AirPodsMuteBridge?

@_cdecl("berd_airpods_mute_start")
public func berdAirPodsMuteStart(
    callback: @escaping InputMuteCallback,
    audioCallback: @escaping AudioInputCallback
) -> Bool {
    guard #available(macOS 14.0, *) else { return false }
    do {
        activeBridge?.stop()
        activeBridge = try AirPodsMuteBridge(
            callback: callback,
            audioCallback: audioCallback
        )
        return true
    } catch {
        FileHandle.standardError.write(
            Data("Berd AirPods mute bridge failed to start: \(error)\n".utf8)
        )
        activeBridge = nil
        return false
    }
}

@_cdecl("berd_airpods_mute_stop")
public func berdAirPodsMuteStop() -> Bool {
    guard #available(macOS 14.0, *) else { return false }
    activeBridge?.stop()
    activeBridge = nil
    return true
}

@_cdecl("berd_airpods_mute_set_muted")
public func berdAirPodsMuteSetMuted(_ muted: Bool) -> Bool {
    guard #available(macOS 14.0, *), activeBridge != nil else { return false }
    do {
        try AVAudioApplication.shared.setInputMuted(muted)
        return true
    } catch {
        return false
    }
}
