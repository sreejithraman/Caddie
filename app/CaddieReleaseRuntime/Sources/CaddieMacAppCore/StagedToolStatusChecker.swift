import CaddieReleaseRuntime
import Foundation

public struct StagedToolStatusChecker: Sendable {
    private let runner: any ToolProcessRunning

    public init() {
        runner = BoundedToolProcessRunner()
    }

    init(runner: any ToolProcessRunning) {
        self.runner = runner
    }

    public func check(binding: ToolReleaseBinding, environment: [String: String]) async throws {
        let requestID = UUID().uuidString.lowercased()
        let request = try JSONSerialization.data(withJSONObject: [
            "version": 2,
            "requestId": requestID,
            "caller": "app",
            "operation": "status",
            "input": [String: Any](),
        ])
        let output = try await runner.run(
            launch: ToolLaunchDescription(
                executable: URL(fileURLWithPath: binding.node.path),
                arguments: [binding.tool.path]
            ),
            environment: environment,
            request: request,
            timeout: 5
        )
        let response = try ToolResponse.validated(output, requestId: requestID, operation: "status")
        guard response.ok else { throw response.error ?? ToolClientFault.invalidResponse }
    }
}
