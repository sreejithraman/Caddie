import CaddieDevelopmentSupport
import CaddieReleaseRuntime
import Foundation
import XCTest

final class DevelopmentReleaseInstallerTests: XCTestCase {
    func testDirectoryFingerprintSurvivesParentCopy() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("caddie-development-copy-tests-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let source = root.appendingPathComponent("source", isDirectory: true)
        let skill = source.appendingPathComponent("skill/tool", isDirectory: true)
        try FileManager.default.createDirectory(at: skill, withIntermediateDirectories: true)
        try Data("tool".utf8).write(to: skill.appendingPathComponent("caddie.mjs"))
        let expected = try ReleaseFingerprint.digest(at: source.appendingPathComponent("skill"))
        let copy = root.appendingPathComponent("copy", isDirectory: true)

        try FileManager.default.copyItem(at: source, to: copy)

        XCTAssertEqual(try ReleaseFingerprint.digest(at: copy.appendingPathComponent("skill")), expected)
    }

    func testInstallsCheckedReleaseAndCreatesIsolatedHome() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("caddie-development-tests-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let app = root.appendingPathComponent("source/Caddie.app", isDirectory: true)
        let node = root.appendingPathComponent("source/node")
        let skill = root.appendingPathComponent("source/skill", isDirectory: true)
        try FileManager.default.createDirectory(
            at: skill.appendingPathComponent("tool", isDirectory: true),
            withIntermediateDirectories: true
        )
        try Data("app".utf8).write(to: app)
        try Data("node".utf8).write(to: node)
        try Data("tool".utf8).write(to: skill.appendingPathComponent("tool/caddie.mjs"))
        try Data("skill".utf8).write(to: skill.appendingPathComponent("SKILL.md"))
        let support = root.appendingPathComponent("support", isDirectory: true)
        let developerHome = support.appendingPathComponent("Developer Home", isDirectory: true)
        try FileManager.default.createDirectory(
            at: developerHome.appendingPathComponent(".agents/.caddie", isDirectory: true),
            withIntermediateDirectories: true
        )

        let record = try await DevelopmentReleaseInstaller().install(
            app: app,
            node: node,
            skill: skill,
            supportRoot: support,
            developerHome: developerHome,
            statusCheck: { binding in
                XCTAssertTrue(binding.tool.path.hasSuffix("/skill/tool/caddie.mjs"))
            }
        )

        XCTAssertTrue(record.active.releaseID.hasPrefix("development-"))
        XCTAssertEqual(record.active, record.lastGood)
        XCTAssertTrue(FileManager.default.fileExists(atPath: developerHome.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: record.active.node.path))
        XCTAssertTrue(FileManager.default.fileExists(
            atPath: developerHome.appendingPathComponent(".agents/.caddie/manifest.json").path
        ))
        let checked = try await CaddieReleaseRuntime(supportRoot: support).checkedLaunchRecord()
        XCTAssertEqual(checked, record)
    }
}
