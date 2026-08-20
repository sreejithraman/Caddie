import Darwin
import Foundation

protocol ToolProcessRunning: Sendable {
    func run(
        launch: ToolLaunchDescription,
        environment: [String: String],
        request: Data,
        timeout: TimeInterval
    ) async throws -> Data
}

enum ToolProcessFault: Error, Equatable {
    case timeout
    case stdoutOverflow
    case stderrOverflow
    case launchFailed(String)
    case failed(status: Int32, diagnostics: String)
}

struct BoundedToolProcessRunner: ToolProcessRunning, Sendable {
    static let maximumStdoutBytes = 16 * 1024 * 1024
    static let maximumStderrBytes = 64 * 1024

    let maximumStdout: Int
    let maximumStderr: Int
    let stopGrace: TimeInterval

    init(
        maximumStdout: Int = Self.maximumStdoutBytes,
        maximumStderr: Int = Self.maximumStderrBytes,
        stopGrace: TimeInterval = 10
    ) {
        self.maximumStdout = maximumStdout
        self.maximumStderr = maximumStderr
        self.stopGrace = stopGrace
    }

    func run(
        launch: ToolLaunchDescription,
        environment: [String: String],
        request: Data,
        timeout: TimeInterval
    ) async throws -> Data {
        let process = Process()
        let input = Pipe()
        let output = Pipe()
        let errors = Pipe()
        let state = ProcessState(maximumStdout: maximumStdout, maximumStderr: maximumStderr)
        let box = ProcessBox(process)
        process.executableURL = launch.executable
        process.arguments = launch.arguments
        process.environment = environment
        process.standardInput = input
        process.standardOutput = output
        process.standardError = errors

        return try await withCheckedThrowingContinuation { continuation in
            output.fileHandleForReading.readabilityHandler = { handle in
                let data = handle.availableData
                guard !data.isEmpty else { handle.readabilityHandler = nil; return }
                if state.appendStdout(data) { stop(box, fault: .stdoutOverflow, state: state, grace: stopGrace) }
            }
            errors.fileHandleForReading.readabilityHandler = { handle in
                let data = handle.availableData
                guard !data.isEmpty else { handle.readabilityHandler = nil; return }
                if state.appendStderr(data) { stop(box, fault: .stderrOverflow, state: state, grace: stopGrace) }
            }
            process.terminationHandler = { process in
                output.fileHandleForReading.readabilityHandler = nil
                errors.fileHandleForReading.readabilityHandler = nil
                state.appendRemaining(
                    stdout: output.fileHandleForReading.readDataToEndOfFile(),
                    stderr: errors.fileHandleForReading.readDataToEndOfFile()
                )
                let result = state.finish(status: process.terminationStatus)
                continuation.resume(with: result)
            }
            do { try process.run() } catch {
                output.fileHandleForReading.readabilityHandler = nil
                errors.fileHandleForReading.readabilityHandler = nil
                continuation.resume(throwing: ToolProcessFault.launchFailed(error.localizedDescription))
                return
            }
            state.installTimeout(after: timeout) {
                stop(box, fault: .timeout, state: state, grace: stopGrace)
            }
            do {
                input.fileHandleForWriting.write(request + Data("\n".utf8))
                try input.fileHandleForWriting.close()
            } catch {
                stop(box, fault: .launchFailed(error.localizedDescription), state: state, grace: stopGrace)
            }
        }
    }
}

private final class ProcessBox: @unchecked Sendable {
    let process: Process
    init(_ process: Process) { self.process = process }
}

private final class ProcessState: @unchecked Sendable {
    private let lock = NSLock()
    private let maximumStdout: Int
    private let maximumStderr: Int
    private var stdout = Data()
    private var stderr = Data()
    private var fault: ToolProcessFault?
    private var timeoutWork: DispatchWorkItem?
    private var finished = false

    init(maximumStdout: Int, maximumStderr: Int) {
        self.maximumStdout = maximumStdout
        self.maximumStderr = maximumStderr
    }

    func appendStdout(_ data: Data) -> Bool { append(data, toStdout: true) }
    func appendStderr(_ data: Data) -> Bool { append(data, toStdout: false) }

    func appendRemaining(stdout: Data, stderr: Data) {
        _ = appendStdout(stdout)
        _ = appendStderr(stderr)
    }

    func installTimeout(after seconds: TimeInterval, action: @escaping @Sendable () -> Void) {
        let work = DispatchWorkItem(block: action)
        lock.withLock { timeoutWork = work }
        DispatchQueue.global().asyncAfter(deadline: .now() + seconds, execute: work)
    }

    func setFault(_ next: ToolProcessFault) -> Bool {
        lock.withLock {
            guard !finished else { return false }
            if fault == nil { fault = next }
            guard fault == next else { return false }
            return true
        }
    }

    func finish(status: Int32) -> Result<Data, Error> {
        lock.withLock {
            finished = true
            timeoutWork?.cancel()
            if let fault { return .failure(fault) }
            if status != 0 {
                return .failure(ToolProcessFault.failed(
                    status: status, diagnostics: String(decoding: stderr, as: UTF8.self)
                ))
            }
            return .success(stdout)
        }
    }

    private func append(_ data: Data, toStdout: Bool) -> Bool {
        lock.withLock {
            guard !finished else { return false }
            if toStdout {
                let available = max(0, maximumStdout - stdout.count)
                if available > 0 { stdout.append(data.prefix(available)) }
                if data.count > available && fault == nil { fault = .stdoutOverflow; return true }
            } else {
                let available = max(0, maximumStderr - stderr.count)
                if available > 0 { stderr.append(data.prefix(available)) }
                if data.count > available && fault == nil { fault = .stderrOverflow; return true }
            }
            return false
        }
    }
}

private func stop(_ box: ProcessBox, fault: ToolProcessFault, state: ProcessState, grace: TimeInterval) {
    guard state.setFault(fault) else { return }
    let pid = box.process.processIdentifier
    guard pid > 0 else { return }
    _ = kill(pid, SIGTERM)
    DispatchQueue.global().asyncAfter(deadline: .now() + grace) {
        if box.process.isRunning { _ = kill(pid, SIGKILL) }
    }
}
