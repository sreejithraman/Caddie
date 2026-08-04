import Foundation
import UserNotifications
import XCTest
@testable import CaddieMacAppCore

final class AppActionsTests: XCTestCase {
    func testActionFaultsGiveClearUserMessages() {
        for fault in [
            AppActionFault.invalidHandoff, .missingPendingAction, .missingOutsideEffect, .notificationDenied,
        ] {
            XCTAssertFalse(fault.localizedDescription.isEmpty)
            XCTAssertNotEqual(fault.localizedDescription, "The operation couldn’t be completed.")
        }
    }

    func testToolProcessFaultsGiveClearMessages() {
        for fault in [
            ToolProcessFault.timeout, .stdoutOverflow, .stderrOverflow,
            .launchFailed("test"), .failed(status: 1, diagnostics: "test"),
        ] {
            XCTAssertFalse(fault.localizedDescription.contains("ToolProcessFault"))
            XCTAssertNotEqual(fault.localizedDescription, "The operation couldn’t be completed.")
        }
        XCTAssertEqual(
            ToolProcessFault.timeout.localizedDescription,
            "Caddie could not finish checking in time. Try Sync now again."
        )
    }

    func testCodexAndClaudeLinksKeepExactFolderAndUnsentPrompt() throws {
        let folder = "/Users/sree/Work folder/skills#a&b"
        let prompt = "Fix Attention 1?\nDo not send yet & keep # exact."
        for provider in AgentProvider.allCases {
            let url = try AgentHandoffLink.url(provider: provider, workFolder: folder, prompt: prompt)
            let parts = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
            let values = Dictionary(uniqueKeysWithValues: try XCTUnwrap(parts.queryItems).map { ($0.name, $0.value) })
            XCTAssertEqual(parts.scheme, provider.rawValue)
            XCTAssertEqual(values[provider == .codex ? "path" : "folder"]!, folder)
            XCTAssertEqual(values[provider == .codex ? "prompt" : "q"]!, prompt)
            XCTAssertNil(values["send"] ?? nil)
        }
    }

    @MainActor
    func testCauseMuteClearsOnlyAfterProofAndSourceMuteNeedsExplicitClear() {
        let defaults = UserDefaults(suiteName: "AppActionsTests-\(UUID().uuidString)")!
        let preferences = NotificationPreferences(defaults: defaults)
        let item = attention(id: "attention-one", stableKey: "source\0code\0cause")
        preferences.muteAttention(stableKey: item.stableKey)
        preferences.muteSource("source")
        XCTAssertTrue(preferences.isMuted(item))

        preferences.reconcile(open: [])
        XCTAssertTrue(preferences.isMuted(item), "the explicit source mute remains")
        preferences.unmuteSource("source")
        XCTAssertFalse(preferences.isMuted(item), "proof cleared the cause mute")
    }

    @MainActor
    func testSourceMuteCoversAttentionOwnedByAChildSkillSelection() {
        let defaults = UserDefaults(suiteName: "SourceMute-\(UUID().uuidString)")!
        let preferences = NotificationPreferences(defaults: defaults)
        let item = AppSnapshot.Attention(
            id: "attention-child", subjectId: "source:skills/child", code: "blocked", priority: "high",
            state: "open", stableKey: "child\u{0}blocked\u{0}cause", condition: "cause", observations: 1,
            createdAt: "2026-08-03T14:00:00Z", updatedAt: "2026-08-03T14:00:00Z"
        )
        preferences.muteSource("source")
        XCTAssertTrue(preferences.isMuted(item, sourceID: "source"))
        XCTAssertFalse(preferences.isMuted(item), "a child selection ID is not itself the source ID")
    }

    @MainActor
    func testDefaultNotificationClickRoutesOnlyTheExactAttentionID() async {
        let router = RecordingAttentionRouter()
        let delegate = AttentionNotificationDelegate(router: router)
        await delegate.routeDefaultAction(
            actionIdentifier: UNNotificationDefaultActionIdentifier,
            userInfo: ["effectId": "effect-one", "attentionId": "attention-exact"]
        )
        XCTAssertEqual(router.ids, ["attention-exact"])
        await delegate.routeDefaultAction(actionIdentifier: "not-default", userInfo: ["attentionId": "other"])
        await delegate.routeDefaultAction(actionIdentifier: UNNotificationDefaultActionIdentifier, userInfo: ["effectId": "no-target"])
        XCTAssertEqual(router.ids, ["attention-exact"])
    }

    @MainActor
    func testOutsideEffectDeliveryIDsAreDeduplicatedAndBounded() {
        let defaults = UserDefaults(suiteName: "AppActionEffects-\(UUID().uuidString)")!
        let preferences = NotificationPreferences(defaults: defaults)
        preferences.markDelivered("effect-one")
        preferences.markDelivered("effect-one")
        XCTAssertTrue(preferences.wasDelivered("effect-one"))
        XCTAssertEqual(defaults.stringArray(forKey: "deliveredOutsideEffects"), ["effect-one"])
    }

    @MainActor
    func testDeliveryQueueKeepsNewestTwoHundredRegardlessOfLexicalID() {
        let defaults = UserDefaults(suiteName: "DeliveryLRU-\(UUID().uuidString)")!
        let preferences = NotificationPreferences(defaults: defaults)
        preferences.markDelivered("z-oldest")
        for index in 0..<200 { preferences.markDelivered("id-\(index)") }
        XCTAssertFalse(preferences.wasDelivered("z-oldest"))
        XCTAssertTrue(preferences.wasDelivered("id-0"))
        XCTAssertTrue(preferences.wasDelivered("id-199"))
        XCTAssertEqual(defaults.stringArray(forKey: "deliveredOutsideEffects")?.count, 200)
    }

    private func attention(id: String, stableKey: String) -> AppSnapshot.Attention {
        .init(
            id: id, subjectId: "source", code: "blocked", priority: "high", state: "open",
            stableKey: stableKey, condition: "cause", observations: 1,
            createdAt: "2026-08-03T14:00:00Z", updatedAt: "2026-08-03T14:00:00Z"
        )
    }
}

@MainActor private final class RecordingAttentionRouter: AttentionRouting {
    var ids: [String] = []
    func openAttention(id: String) { ids.append(id) }
}
