import Darwin
import Foundation
import CaddieReleaseRuntime

@main
struct CrashFixture {
    static func main() async throws {
        let arguments = CommandLine.arguments
        guard arguments.count == 4, let step = CaddieReleaseRuntime.Step(rawValue: arguments[3]) else {
            throw FixtureFault.invalidArguments
        }
        let runtime = CaddieReleaseRuntime(
            supportRoot: URL(fileURLWithPath: arguments[1]),
            observeStep: { observed in if observed == step { _exit(86) } }
        )
        _ = try await runtime.stageCheckAndActivate(release: URL(fileURLWithPath: arguments[2])) { _ in }
    }
}

enum FixtureFault: Error { case invalidArguments }
