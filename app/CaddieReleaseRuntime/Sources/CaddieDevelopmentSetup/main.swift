import CaddieDevelopmentSupport
import Foundation

@main
enum CaddieDevelopmentSetupCommand {
    static func main() async throws {
        let arguments = CommandLine.arguments
        guard arguments.count == 4 else {
            FileHandle.standardError.write(Data("Usage: CaddieDevelopmentSetup <app> <node> <skill>\n".utf8))
            Foundation.exit(2)
        }
        let supportRoot = ProcessInfo.processInfo.environment["CADDIE_DEVELOPMENT_SUPPORT_ROOT"].map {
            URL(fileURLWithPath: $0, isDirectory: true)
        } ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Caddie Development", isDirectory: true)
        let developerHome = supportRoot.appendingPathComponent("Developer Home", isDirectory: true)
        let record = try await DevelopmentReleaseInstaller().install(
            app: URL(fileURLWithPath: arguments[1]),
            node: URL(fileURLWithPath: arguments[2]),
            skill: URL(fileURLWithPath: arguments[3]),
            supportRoot: supportRoot,
            developerHome: developerHome
        )
        print("Prepared \(record.active.releaseID) in \(supportRoot.path)")
    }
}
