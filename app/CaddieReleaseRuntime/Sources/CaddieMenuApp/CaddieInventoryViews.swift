import CaddieMacAppCore
import SwiftUI

struct DetailValue: View {
    let label: String
    let value: String

    var body: some View {
        LabeledContent(label) {
            Text(value).textSelection(.enabled).multilineTextAlignment(.trailing)
        }
    }
}

struct CaddieAttentionActions: View {
    @ObservedObject var model: AppModel
    let item: AppSnapshot.Attention
    let allowHandoff: Bool

    var body: some View {
        HStack {
            Button("Retry") { Task { await model.retry(attentionID: item.id) } }
            Button(model.isMuted(item) ? "Unmute" : "Mute") {
                if model.isMuted(item) { model.unmute(item) } else { model.mute(item) }
            }
            if allowHandoff {
                Menu("Open in Agent") {
                    Button("\(model.lastAgentProvider.displayName) (Last used)") {
                        Task { await model.handoff(attentionID: item.id, provider: model.lastAgentProvider) }
                    }
                    let other: AgentProvider = model.lastAgentProvider == .codex ? .claude : .codex
                    Button(other.displayName) {
                        Task { await model.handoff(attentionID: item.id, provider: other) }
                    }
                }
            }
        }
        .disabled(model.isPreview)
    }
}

struct EmptyInventoryView: View {
    let title: String
    let message: String
    let symbol: String

    var body: some View {
        Group {
            if #available(macOS 14.0, *) {
                ContentUnavailableView(title, systemImage: symbol, description: Text(message))
            } else {
                VStack(spacing: 8) {
                    Image(systemName: symbol).font(.largeTitle).foregroundStyle(.secondary)
                    Text(title).font(.headline)
                    Text(message).foregroundStyle(.secondary)
                }
                .multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 220)
    }
}

struct MissingInventoryItem: View {
    let title: String

    var body: some View {
        Group {
            if #available(macOS 14.0, *) {
                ContentUnavailableView(
                    title,
                    systemImage: "arrow.clockwise",
                    description: Text("Caddie refreshed while this page was open. Go back to see the current list.")
                )
            } else {
                VStack(spacing: 8) {
                    Image(systemName: "arrow.clockwise").font(.largeTitle).foregroundStyle(.secondary)
                    Text(title).font(.headline)
                    Text("Caddie refreshed while this page was open. Go back to see the current list.")
                        .foregroundStyle(.secondary)
                }
                .multilineTextAlignment(.center)
                .padding()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

extension AppSnapshot.InventorySkill {
    func matches(_ query: String) -> Bool {
        name.localizedCaseInsensitiveContains(query)
            || origin?.name.localizedCaseInsensitiveContains(query) == true
            || installedPath.localizedCaseInsensitiveContains(query)
    }
}
