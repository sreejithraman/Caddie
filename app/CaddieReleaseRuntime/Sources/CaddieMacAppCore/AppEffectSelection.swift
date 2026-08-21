import Foundation

enum AppEffectSelection {
    static func handoffEffect(
        in snapshot: AppSnapshot,
        attentionID: String,
        provider: AgentProvider
    ) -> AppSnapshot.OutsideEffect? {
        snapshot.outsideEffects.first {
            $0.kind == "agent-handoff" && $0.attentionId == attentionID && $0.provider == provider.rawValue
        }
    }

    static func pendingHandoffAction(
        in snapshot: AppSnapshot,
        attentionID: String,
        provider: AgentProvider
    ) -> AppSnapshot.PendingAction? {
        snapshot.pendingActions.first {
            $0.intent.type == "agent-handoff" && $0.intent.attentionId == attentionID
                && $0.intent.provider == provider.rawValue
        }
    }

    static func nextNotification(
        in snapshot: AppSnapshot
    ) -> (AppSnapshot.OutsideEffect, AppSnapshot.Attention)? {
        for effect in snapshot.outsideEffects where effect.kind == "notification" && effect.outcome == nil {
            guard let id = effect.attentionId,
                  let item = (snapshot.attention + snapshot.recentAttention).first(where: { $0.id == id }) else {
                continue
            }
            return (effect, item)
        }
        return nil
    }
}
