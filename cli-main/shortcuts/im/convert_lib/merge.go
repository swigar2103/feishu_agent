// Copyright (c) 2026 Lark Technologies Pte. Ltd.
// SPDX-License-Identifier: MIT

package convertlib

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/larksuite/cli/internal/validate"
	"github.com/larksuite/cli/shortcuts/common"
	larkcore "github.com/larksuite/oapi-sdk-go/v3/core"
)

type mergeForwardConverter struct{}

// Convert expands merge_forward sub-messages into a tree when runtime is available,
// otherwise falls back to a summary string.
func (mergeForwardConverter) Convert(ctx *ConvertContext) string {
	// When runtime is available, fetch sub-messages via API and expand into a tree.
	// merge_forward body.content is typically a plain-text placeholder (e.g. "Merged and Forwarded Message"),
	// not JSON with create_message_ids, so we must rely on the API to get actual sub-messages.
	if ctx.Runtime != nil && ctx.MessageID != "" {
		subItems, err := fetchMergeForwardSubMessages(ctx.MessageID, ctx.Runtime)
		if err != nil {
			return fmt.Sprintf("[Merged forward: fetch failed: %s]", err)
		}
		if len(subItems) > 0 {
			// Resolve sender names using shared cache to avoid redundant API calls across merge_forward messages
			nameMap := ResolveSenderNames(ctx.Runtime, subItems, ctx.SenderNames)
			AttachSenderNames(subItems, nameMap)
			childrenMap := BuildMergeForwardChildrenMap(subItems, ctx.MessageID)
			return FormatMergeForwardSubTree(ctx.MessageID, childrenMap)
		}
	}
	// Fallback: try to extract message IDs from content (some older formats include them)
	ids := ParseMergeForwardIDs(ctx.RawContent)
	if len(ids) > 0 {
		return fmt.Sprintf("[Merged forward: %d messages]", len(ids))
	}
	return "[Merged forward]"
}

// fetchMergeForwardSubMessages fetches all sub-messages in a merge_forward container
// via a single API call. Returns a flat list of raw message items with upper_message_id
// for tree reconstruction.
func fetchMergeForwardSubMessages(messageID string, runtime *common.RuntimeContext) ([]map[string]interface{}, error) {
	apiResp, err := runtime.DoAPI(&larkcore.ApiReq{
		HttpMethod: http.MethodGet,
		ApiPath:    mergeForwardMessagesPath(messageID),
		QueryParams: larkcore.QueryParams{
			"user_id_type":          []string{"open_id"},
			"card_msg_content_type": []string{"raw_card_content"},
		},
	})
	if err != nil {
		return nil, err
	}

	var result map[string]interface{}
	if err := json.Unmarshal(apiResp.RawBody, &result); err != nil {
		return nil, fmt.Errorf("invalid response: %w", err)
	}
	data, _ := result["data"].(map[string]interface{})
	if data == nil {
		return nil, fmt.Errorf("empty data")
	}

	rawItems, _ := data["items"].([]interface{})
	items := make([]map[string]interface{}, 0, len(rawItems))
	for _, raw := range rawItems {
		if m, ok := raw.(map[string]interface{}); ok {
			items = append(items, m)
		}
	}
	return items, nil
}

func mergeForwardMessagesPath(messageID string) string {
	return fmt.Sprintf("/open-apis/im/v1/messages/%s", validate.EncodePathSegment(messageID))
}

// ParseMergeForwardIDs extracts message IDs from a merge_forward content JSON.
func ParseMergeForwardIDs(raw string) []string {
	parsed, err := ParseJSONObject(raw)
	if err != nil {
		return nil
	}
	rawIds, _ := parsed["create_message_ids"].([]interface{})
	ids := make([]string, 0, len(rawIds))
	for _, id := range rawIds {
		if s, ok := id.(string); ok {
			ids = append(ids, s)
		}
	}
	return ids
}

// BuildMergeForwardChildrenMap builds a parent→children map from a flat items list.
// Items without upper_message_id are treated as direct children of rootMessageID.
// The root container message itself is skipped.
func BuildMergeForwardChildrenMap(items []map[string]interface{}, rootMessageID string) map[string][]map[string]interface{} {
	result := make(map[string][]map[string]interface{})
	for _, item := range items {
		msgID, _ := item["message_id"].(string)
		upperID, _ := item["upper_message_id"].(string)
		// Skip the root container itself
		if msgID == rootMessageID && upperID == "" {
			continue
		}
		parentID := upperID
		if parentID == "" {
			parentID = rootMessageID
		}
		result[parentID] = append(result[parentID], item)
	}
	// Sort each group by create_time ascending
	for _, children := range result {
		sort.Slice(children, func(i, j int) bool {
			return mergeForwardItemTimestamp(children[i]) < mergeForwardItemTimestamp(children[j])
		})
	}
	return result
}

// FormatMergeForwardSubTree recursively formats a sub-tree rooted at parentID.
// For merge_forward children it recurses via the tree (no extra API calls).
// For other types it delegates to the provided convert callback.
func FormatMergeForwardSubTree(parentID string, childrenMap map[string][]map[string]interface{}) string {
	children := childrenMap[parentID]
	if len(children) == 0 {
		return "<forwarded_messages/>"
	}

	var parts []string
	for _, item := range children {
		msgType, _ := item["msg_type"].(string)
		if msgType == "" {
			msgType = "text"
		}

		senderID := "unknown"
		if senderMap, ok := item["sender"].(map[string]interface{}); ok {
			if name, _ := senderMap["name"].(string); name != "" {
				senderID = name
			} else if id, _ := senderMap["id"].(string); id != "" {
				senderID = id
			}
		}

		tsStr, _ := item["create_time"].(string)
		timestamp := FormatMergeForwardTimestamp(tsStr)

		var content string
		msgID, _ := item["message_id"].(string)
		if msgType == "merge_forward" && msgID != "" {
			content = FormatMergeForwardSubTree(msgID, childrenMap)
		} else {
			rawContent := ""
			if body, ok := item["body"].(map[string]interface{}); ok {
				rawContent, _ = body["content"].(string)
			}
			mentions, _ := item["mentions"].([]interface{})
			content = ConvertBodyContent(msgType, &ConvertContext{
				RawContent: rawContent,
				MentionMap: BuildMentionKeyMap(mentions),
			})
		}

		parts = append(parts, fmt.Sprintf("[%s] %s:\n%s", timestamp, senderID, IndentLines(content, "    ")))
	}

	if len(parts) == 0 {
		return "<forwarded_messages/>"
	}
	return "<forwarded_messages>\n" + strings.Join(parts, "\n") + "\n</forwarded_messages>"
}

// FormatMergeForwardTimestamp formats a millisecond timestamp string to local RFC3339 with offset.
func FormatMergeForwardTimestamp(tsStr string) string {
	var ms int64
	fmt.Sscanf(tsStr, "%d", &ms)
	if ms == 0 {
		return "unknown"
	}
	t := time.Unix(ms/1000, (ms%1000)*int64(time.Millisecond)).In(time.Local)
	return t.Format(time.RFC3339)
}

// IndentLines prefixes every line of text with the given indent string.
func IndentLines(text, indent string) string {
	lines := strings.Split(text, "\n")
	for i, line := range lines {
		lines[i] = indent + line
	}
	return strings.Join(lines, "\n")
}

// mergeForwardItemTimestamp returns the create_time as int64 milliseconds.
func mergeForwardItemTimestamp(item map[string]interface{}) int64 {
	ts, _ := item["create_time"].(string)
	var n int64
	fmt.Sscanf(ts, "%d", &n)
	return n
}
