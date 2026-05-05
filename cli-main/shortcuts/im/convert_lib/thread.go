// Copyright (c) 2026 Lark Technologies Pte. Ltd.
// SPDX-License-Identifier: MIT

package convertlib

import (
	"fmt"
	"net/http"

	"github.com/larksuite/cli/shortcuts/common"
	larkcore "github.com/larksuite/oapi-sdk-go/v3/core"
)

// ThreadRepliesPerThread is the default max replies fetched per thread in auto-expand.
const ThreadRepliesPerThread = 50

// ThreadRepliesTotalLimit is the default max total thread replies across all threads.
const ThreadRepliesTotalLimit = 500

// ExpandThreadReplies fetches and embeds thread replies for messages that contain a thread_id.
// For each unique thread_id found in messages, it fetches up to perThread replies (asc order)
// and attaches them as "thread_replies" on the message. Expansion stops once totalLimit
// cumulative replies have been fetched. nameCache is the shared open_id→name map.
func ExpandThreadReplies(runtime *common.RuntimeContext, messages []map[string]interface{}, nameCache map[string]string, perThread, totalLimit int) {
	if runtime == nil {
		return
	}
	if perThread < 1 {
		perThread = 1
	}
	if perThread > 50 {
		perThread = 50
	}
	if totalLimit <= 0 {
		totalLimit = ThreadRepliesTotalLimit
	}

	totalFetched := 0
	seen := make(map[string]bool)

	for _, msg := range messages {
		if totalFetched >= totalLimit {
			break
		}
		tid, _ := msg["thread_id"].(string)
		if tid == "" || seen[tid] {
			continue
		}
		seen[tid] = true

		limit := perThread
		if remaining := totalLimit - totalFetched; limit > remaining {
			limit = remaining
		}

		rawReplies, hasMore, fetchErr := fetchThreadReplies(runtime, tid, limit)
		if fetchErr != nil {
			// Preserve the outer message while surfacing that thread expansion failed.
			msg["thread_replies_error"] = true
			continue
		}
		// Successful fetches always return a non-nil (possibly empty) slice.
		// A nil slice indicates thread expansion did not complete.
		if rawReplies == nil {
			msg["thread_replies_error"] = true
			continue
		}
		if len(rawReplies) == 0 {
			continue
		}

		replies := make([]map[string]interface{}, 0, len(rawReplies))
		for _, r := range rawReplies {
			replies = append(replies, FormatMessageItem(r, runtime, nameCache))
		}
		ResolveSenderNames(runtime, replies, nameCache)
		AttachSenderNames(replies, nameCache)

		msg["thread_replies"] = replies
		if hasMore {
			msg["thread_has_more"] = true
		}
		totalFetched += len(rawReplies)
	}
}

// fetchThreadReplies fetches up to limit replies from a thread (ascending order).
// Returns the raw message items, whether more replies exist beyond the limit,
// and a non-nil error when the API call fails.
func fetchThreadReplies(runtime *common.RuntimeContext, threadID string, limit int) ([]map[string]interface{}, bool, error) {
	data, err := runtime.DoAPIJSON(http.MethodGet, "/open-apis/im/v1/messages", larkcore.QueryParams{
		"container_id_type":     []string{"thread"},
		"container_id":          []string{threadID},
		"sort_type":             []string{"ByCreateTimeAsc"},
		"page_size":             []string{fmt.Sprint(limit)},
		"card_msg_content_type": []string{"raw_card_content"},
	}, nil)
	if err != nil {
		return nil, false, fmt.Errorf("fetch thread replies for %s: %w", threadID, err)
	}
	hasMore, _ := data["has_more"].(bool)
	rawItems, _ := data["items"].([]interface{})
	items := make([]map[string]interface{}, 0, len(rawItems))
	for _, raw := range rawItems {
		if m, ok := raw.(map[string]interface{}); ok {
			items = append(items, m)
		}
	}
	return items, hasMore, nil
}
