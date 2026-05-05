// Copyright (c) 2026 Lark Technologies Pte. Ltd.
// SPDX-License-Identifier: MIT

package convertlib

import (
	"fmt"
	"strings"

	"github.com/larksuite/cli/shortcuts/common"
)

// ContentConverter defines the interface for converting a message type's raw content to human-readable text.
type ContentConverter interface {
	Convert(ctx *ConvertContext) string
}

// ConvertContext holds all context needed for content conversion.
type ConvertContext struct {
	RawContent string
	MentionMap map[string]string
	// MessageID and Runtime are used by merge_forward to fetch and expand sub-messages via API.
	// For other message types these can be zero values.
	MessageID string
	Runtime   *common.RuntimeContext
	// SenderNames is a shared cache of open_id -> display name, accumulated across messages
	// to avoid redundant contact API calls. May be nil.
	SenderNames map[string]string
}

// converters maps message types to their ContentConverter implementations.
var converters map[string]ContentConverter

func init() {
	converters = map[string]ContentConverter{
		"text":                 textConverter{},
		"post":                 postConverter{},
		"image":                imageConverter{},
		"file":                 fileConverter{},
		"audio":                audioMsgConverter{},
		"video":                videoMsgConverter{},
		"media":                videoMsgConverter{},
		"sticker":              stickerConverter{},
		"interactive":          interactiveConverter{},
		"share_chat":           shareChatConverter{},
		"share_user":           shareUserConverter{},
		"location":             locationConverter{},
		"merge_forward":        mergeForwardConverter{},
		"folder":               folderConverter{},
		"share_calendar_event": calendarEventConverter{},
		"calendar":             calendarInviteConverter{},
		"general_calendar":     generalCalendarConverter{},
		"video_chat":           videoChatConverter{},
		"system":               systemConverter{},
		"todo":                 todoConverter{},
		"vote":                 voteConverter{},
		"hongbao":              hongbaoConverter{},
	}
}

// ConvertBodyContent converts body.content (a raw JSON string) to human-readable text.
func ConvertBodyContent(msgType string, ctx *ConvertContext) string {
	if ctx.RawContent == "" {
		return ""
	}
	if c, ok := converters[msgType]; ok {
		return c.Convert(ctx)
	}
	return fmt.Sprintf("[%s]", msgType)
}

// FormatEventMessage converts an event-pushed message to a human-readable map.
// Event messages have a different structure from API responses:
//   - message_type (not msg_type), content is a direct JSON string (not under body.content)
//   - mentions are nested under message.mentions
//
// This is the entry point for im.message.receive_v1 event processors.
func FormatEventMessage(msgType, rawContent, messageID string, mentions []interface{}) map[string]interface{} {
	content := ConvertBodyContent(msgType, &ConvertContext{
		RawContent: rawContent,
		MentionMap: BuildMentionKeyMap(mentions),
		MessageID:  messageID,
	})

	msg := map[string]interface{}{
		"msg_type": msgType,
		"content":  content,
	}

	if len(mentions) > 0 {
		simplified := make([]map[string]interface{}, 0, len(mentions))
		for _, raw := range mentions {
			item, _ := raw.(map[string]interface{})
			key, _ := item["key"].(string)
			name, _ := item["name"].(string)
			simplified = append(simplified, map[string]interface{}{
				"key":  key,
				"id":   extractMentionOpenId(item["id"]),
				"name": name,
			})
		}
		msg["mentions"] = simplified
	}

	return msg
}

// FormatMessageItem converts a raw API message item to a human-readable map.
// senderNames is an optional shared cache (open_id -> name) accumulated across messages;
// pass nil to disable sender name caching.
func FormatMessageItem(m map[string]interface{}, runtime *common.RuntimeContext, senderNames ...map[string]string) map[string]interface{} {
	var nameCache map[string]string
	if len(senderNames) > 0 {
		nameCache = senderNames[0]
	}
	msgType, _ := m["msg_type"].(string)
	messageId, _ := m["message_id"].(string)
	mentions, _ := m["mentions"].([]interface{})
	deleted, _ := m["deleted"].(bool)
	updated, _ := m["updated"].(bool)

	content := ""
	if body, ok := m["body"].(map[string]interface{}); ok {
		rawContent, _ := body["content"].(string)
		content = ConvertBodyContent(msgType, &ConvertContext{
			RawContent:  rawContent,
			MentionMap:  BuildMentionKeyMap(mentions),
			MessageID:   messageId,
			Runtime:     runtime,
			SenderNames: nameCache,
		})
	}

	msg := map[string]interface{}{
		"message_id":  messageId,
		"msg_type":    msgType,
		"content":     content,
		"sender":      m["sender"],
		"create_time": common.FormatTime(m["create_time"]),
		"deleted":     deleted,
		"updated":     updated,
	}

	// thread_id takes priority; fall back to reply_to (parent_id) if no thread
	if tid, _ := m["thread_id"].(string); tid != "" {
		msg["thread_id"] = tid
	} else if pid, _ := m["parent_id"].(string); pid != "" {
		msg["reply_to"] = pid
	}

	if len(mentions) > 0 {
		simplified := make([]map[string]interface{}, 0, len(mentions))
		for _, raw := range mentions {
			item, _ := raw.(map[string]interface{})
			key, _ := item["key"].(string)
			name, _ := item["name"].(string)
			simplified = append(simplified, map[string]interface{}{
				"key":  key,
				"id":   extractMentionOpenId(item["id"]),
				"name": name,
			})
		}
		msg["mentions"] = simplified
	}

	return msg
}

// extractMentionOpenId extracts open_id from mention id (string or {"open_id":...} object).
func extractMentionOpenId(id interface{}) string {
	if s, ok := id.(string); ok {
		return s
	}
	if m, ok := id.(map[string]interface{}); ok {
		if openId, ok := m["open_id"].(string); ok {
			return openId
		}
	}
	return ""
}

// TruncateContent truncates a string for table display.
func TruncateContent(s string, max int) string {
	s = strings.ReplaceAll(s, "\n", " ")
	runes := []rune(s)
	if len(runes) <= max {
		return s
	}
	return string(runes[:max]) + "…"
}
