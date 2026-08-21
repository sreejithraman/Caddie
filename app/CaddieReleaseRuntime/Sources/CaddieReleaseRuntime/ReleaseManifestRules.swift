import Foundation

enum ReleaseManifestRules {
    static func validateManifest(_ manifest: CaddieReleaseManifest) throws {
        guard manifest.version == 1 else { throw ReleaseRuntimeFault.unsupportedManifestVersion(manifest.version) }
        let idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
        guard manifest.releaseID.wholeMatch(of: idPattern) != nil else { throw ReleaseRuntimeFault.invalidReleaseID }
        guard manifest.compatibility == .caddieCurrent else {
            throw ReleaseRuntimeFault.incompatibleRelease("the required protocol or state range is absent")
        }
        for artifact in [manifest.app, manifest.node, manifest.tool, manifest.skill] {
            guard !artifact.version.isEmpty, artifact.fingerprint.wholeMatch(of: /^[a-f0-9]{64}$/) != nil else {
                throw ReleaseRuntimeFault.malformedManifest
            }
            _ = try safeRelativePath(artifact.path)
        }
    }

    static func safeRelativePath(_ value: String) throws -> String {
        let components = value.split(separator: "/", omittingEmptySubsequences: false)
        let path = NSString(string: value).standardizingPath
        guard !value.isEmpty, !value.hasPrefix("/"),
              !components.contains(where: { $0 == ".." || $0 == "." || $0.isEmpty }),
              path != ".", path != "..", !path.hasPrefix("../") else {
            throw ReleaseRuntimeFault.invalidArtifactPath(value)
        }
        return path
    }

    static func absoluteBinding(
        _ manifest: CaddieReleaseManifest,
        releaseRoot: URL
    ) -> ToolReleaseBinding {
        func bind(_ artifact: ReleaseArtifact) -> ReleaseArtifact {
            ReleaseArtifact(
                version: artifact.version,
                path: releaseRoot.appendingPathComponent(artifact.path).standardizedFileURL.path,
                fingerprint: artifact.fingerprint
            )
        }
        return ToolReleaseBinding(
            releaseID: manifest.releaseID,
            releasePath: releaseRoot.standardizedFileURL.path,
            node: bind(manifest.node),
            tool: bind(manifest.tool),
            skill: bind(manifest.skill),
            compatibility: manifest.compatibility
        )
    }
}
