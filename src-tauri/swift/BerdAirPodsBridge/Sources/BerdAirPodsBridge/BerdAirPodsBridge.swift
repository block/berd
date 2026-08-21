import AVFoundation
import BerdObjCExceptionCatch
import Foundation

public typealias InputMuteCallback = @convention(c) (Bool) -> Void
public typealias AudioInputCallback = @convention(c) (UnsafePointer<Float>, Int) -> Void
public typealias CaptureStateCallback = @convention(c) (Bool) -> Void

private let bridgeQueueKey = DispatchSpecificKey<Void>()
private let bridgeQueue: DispatchQueue = {
    let queue = DispatchQueue(label: "com.berd.airpods-mute-bridge")
    queue.setSpecific(key: bridgeQueueKey, value: ())
    return queue
}()

private func onBridgeQueue<T>(_ body: () -> T) -> T {
    if DispatchQueue.getSpecific(key: bridgeQueueKey) != nil {
        return body()
    }
    return bridgeQueue.sync(execute: body)
}

@available(macOS 14.0, *)
private final class AirPodsMuteBridge: @unchecked Sendable {
    private let callback: InputMuteCallback
    private let audioCallback: AudioInputCallback
    private let captureStateCallback: CaptureStateCallback
    private var engine: AVAudioEngine?
    private var inputNode: AVAudioInputNode?
    private var configurationObserver: NSObjectProtocol?
    private var inputMuteObserver: NSObjectProtocol?
    private var restartWorkItem: DispatchWorkItem?
    private var restartGeneration: UInt64 = 0
    private var isStopped = false

    init(
        callback: @escaping InputMuteCallback,
        audioCallback: @escaping AudioInputCallback,
        captureStateCallback: @escaping CaptureStateCallback
    ) throws {
        self.callback = callback
        self.audioCallback = audioCallback
        self.captureStateCallback = captureStateCallback

        do {
            try startCapture()

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
                queue: nil
            ) { [weak self] _ in
                guard let self else { return }
                self.callback(AVAudioApplication.shared.isInputMuted)
            }
        } catch {
            teardownCapture()
            throw error
        }
    }

    func stop() {
        guard !isStopped else { return }
        isStopped = true
        restartGeneration &+= 1
        restartWorkItem?.cancel()
        restartWorkItem = nil

        // Reset while the handler exists, then cancel the process-wide callback.
        try? AVAudioApplication.shared.setInputMuted(false)
        try? AVAudioApplication.shared.setInputMuteStateChangeHandler(nil)
        if let inputMuteObserver {
            NotificationCenter.default.removeObserver(inputMuteObserver)
            self.inputMuteObserver = nil
        }
        teardownCapture()
    }

    private func startCapture() throws {
        let engine = AVAudioEngine()
        var caughtInputNode: AVAudioInputNode?
        var inputNodeError: NSError?
        BerdTryObjCBlock({
            caughtInputNode = engine.inputNode
        }, &inputNodeError)
        guard inputNodeError == nil, let inputNode = caughtInputNode else {
            throw BridgeError.objectiveC(inputNodeError?.localizedDescription ?? "no input node")
        }

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

        var tapError: NSError?
        BerdTryObjCBlock({
            inputNode.installTap(
                onBus: 0,
                bufferSize: 4096,
                format: inputFormat
            ) { [weak self] buffer, _ in
                self?.forward(buffer, targetFormat: targetFormat, converter: converter)
            }
        }, &tapError)
        guard tapError == nil else {
            throw BridgeError.objectiveC(tapError?.localizedDescription ?? "install tap failed")
        }

        do {
            engine.prepare()
            try engine.start()
        } catch {
            removeTap(from: inputNode)
            engine.stop()
            throw error
        }

        configurationObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange,
            object: engine,
            queue: nil
        ) { [weak self] _ in
            self?.scheduleConfigurationRestart()
        }
        self.engine = engine
        self.inputNode = inputNode
    }

    private func teardownCapture() {
        if let configurationObserver {
            NotificationCenter.default.removeObserver(configurationObserver)
            self.configurationObserver = nil
        }
        if let inputNode {
            removeTap(from: inputNode)
        }
        engine?.stop()
        inputNode = nil
        engine = nil
    }

    private func removeTap(from inputNode: AVAudioInputNode) {
        var removeError: NSError?
        BerdTryObjCBlock({
            inputNode.removeTap(onBus: 0)
        }, &removeError)
        if let removeError {
            FileHandle.standardError.write(
                Data("Berd AirPods bridge could not remove its microphone tap: \(removeError)\n".utf8)
            )
        }
    }

    private func scheduleConfigurationRestart() {
        bridgeQueue.async { [weak self] in
            guard let self, !self.isStopped else { return }
            self.restartGeneration &+= 1
            let generation = self.restartGeneration
            self.restartWorkItem?.cancel()
            let workItem = DispatchWorkItem { [weak self] in
                self?.restartCapture(generation: generation, attempt: 0)
            }
            self.restartWorkItem = workItem
            bridgeQueue.asyncAfter(deadline: .now() + 0.15, execute: workItem)
        }
    }

    private func restartCapture(generation: UInt64, attempt: Int) {
        guard !isStopped, generation == restartGeneration else { return }
        restartWorkItem = nil
        captureStateCallback(false)
        teardownCapture()
        do {
            try startCapture()
            captureStateCallback(true)
        } catch {
            let delays: [TimeInterval] = [0.3, 0.6, 1.2, 2.4, 4.8]
            if attempt == delays.count {
                FileHandle.standardError.write(
                    Data("Berd AirPods bridge is still retrying microphone capture: \(error)\n".utf8)
                )
            }
            let workItem = DispatchWorkItem { [weak self] in
                self?.restartCapture(
                    generation: generation,
                    attempt: min(attempt + 1, delays.count + 1)
                )
            }
            restartWorkItem = workItem
            bridgeQueue.asyncAfter(
                deadline: .now() + delays[min(attempt, delays.count - 1)],
                execute: workItem
            )
        }
    }

    private func forward(
        _ source: AVAudioPCMBuffer,
        targetFormat: AVAudioFormat,
        converter: AVAudioConverter?
    ) {
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
        case objectiveC(String)
    }
}

@available(macOS 14.0, *)
private var activeBridge: AirPodsMuteBridge?

@_cdecl("berd_airpods_mute_start")
public func berdAirPodsMuteStart(
    callback: @escaping InputMuteCallback,
    audioCallback: @escaping AudioInputCallback,
    captureStateCallback: @escaping CaptureStateCallback
) -> Bool {
    guard #available(macOS 14.0, *) else { return false }
    return onBridgeQueue {
        do {
            activeBridge?.stop()
            activeBridge = try AirPodsMuteBridge(
                callback: callback,
                audioCallback: audioCallback,
                captureStateCallback: captureStateCallback
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
}

@_cdecl("berd_airpods_mute_stop")
public func berdAirPodsMuteStop() -> Bool {
    guard #available(macOS 14.0, *) else { return false }
    return onBridgeQueue {
        activeBridge?.stop()
        activeBridge = nil
        return true
    }
}

@_cdecl("berd_airpods_mute_set_muted")
public func berdAirPodsMuteSetMuted(_ muted: Bool) -> Bool {
    guard #available(macOS 14.0, *) else { return false }
    return onBridgeQueue {
        guard activeBridge != nil else { return false }
        do {
            try AVAudioApplication.shared.setInputMuted(muted)
            return true
        } catch {
            return false
        }
    }
}
