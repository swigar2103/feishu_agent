// Copyright (c) 2026 Lark Technologies Pte. Ltd.
// SPDX-License-Identifier: MIT

package convertlib

import (
	"testing"

	"github.com/larksuite/cli/shortcuts/common"
)

func TestConvertBodyContent(t *testing.T) {
	ctx := &ConvertContext{RawContent: `{"text":"hello"}`}

	if got := ConvertBodyContent("text", ctx); got != "hello" {
		t.Fatalf("ConvertBodyContent(text) = %q, want %q", got, "hello")
	}
	if got := ConvertBodyContent("unknown_type", ctx); got != "[unknown_type]" {
		t.Fatalf("ConvertBodyContent(unknown) = %q, want %q", got, "[unknown_type]")
	}
	if got := ConvertBodyContent("text", &ConvertContext{}); got != "" {
		t.Fatalf("ConvertBodyContent(empty) = %q, want empty", got)
	}
}

func TestFormatMessageItem(t *testing.T) {
	raw := map[string]interface{}{
		"msg_type":    "text",
		"message_id":  "om_123",
		"deleted":     true,
		"updated":     true,
		"thread_id":   "omt_1",
		"create_time": "1710500000",
		"sender": map[string]interface{}{
			"id":          "ou_sender",
			"sender_type": "user",
		},
		"mentions": []interface{}{
			map[string]interface{}{"key": "@_user_1", "id": map[string]interface{}{"open_id": "ou_alice"}, "name": "Alice"},
		},
		"body": map[string]interface{}{
			"content": `{"text":"hi @_user_1"}`,
		},
	}

	got := FormatMessageItem(raw, nil)
	if got["message_id"] != "om_123" {
		t.Fatalf("FormatMessageItem() message_id = %#v", got["message_id"])
	}
	if got["content"] != "hi @Alice" {
		t.Fatalf("FormatMessageItem() content = %#v, want %#v", got["content"], "hi @Alice")
	}
	if got["create_time"] != common.FormatTime("1710500000") {
		t.Fatalf("FormatMessageItem() create_time = %#v, want %#v", got["create_time"], common.FormatTime("1710500000"))
	}
	if got["thread_id"] != "omt_1" {
		t.Fatalf("FormatMessageItem() thread_id = %#v, want %#v", got["thread_id"], "omt_1")
	}
	mentions, _ := got["mentions"].([]map[string]interface{})
	if len(mentions) != 1 || mentions[0]["id"] != "ou_alice" {
		t.Fatalf("FormatMessageItem() mentions = %#v", got["mentions"])
	}
}

func TestExtractMentionOpenIdAndTruncateContent(t *testing.T) {
	if got := extractMentionOpenId("ou_1"); got != "ou_1" {
		t.Fatalf("extractMentionOpenId(string) = %q", got)
	}
	if got := extractMentionOpenId(map[string]interface{}{"open_id": "ou_2"}); got != "ou_2" {
		t.Fatalf("extractMentionOpenId(map) = %q", got)
	}
	if got := extractMentionOpenId(123); got != "" {
		t.Fatalf("extractMentionOpenId(other) = %q, want empty", got)
	}

	if got := TruncateContent("hello\nworld", 20); got != "hello world" {
		t.Fatalf("TruncateContent(no truncate) = %q", got)
	}
	if got := TruncateContent("你好世界和平", 4); got != "你好世界…" {
		t.Fatalf("TruncateContent(truncate) = %q", got)
	}
}

func TestMediaConverters(t *testing.T) {
	if got := (imageConverter{}).Convert(&ConvertContext{RawContent: `{"image_key":"img_1"}`}); got != "[Image: img_1]" {
		t.Fatalf("imageConverter.Convert() = %q", got)
	}
	if got := (imageConverter{}).Convert(&ConvertContext{RawContent: `{invalid`}); got != "[Invalid image JSON]" {
		t.Fatalf("imageConverter.Convert(invalid) = %q", got)
	}
	if got := (fileConverter{}).Convert(&ConvertContext{RawContent: `{"file_key":"file_1","file_name":"demo.pdf"}`}); got != `<file key="file_1" name="demo.pdf"/>` {
		t.Fatalf("fileConverter.Convert() = %q", got)
	}
	if got := (fileConverter{}).Convert(&ConvertContext{RawContent: `{"file_key":"file_\"1","file_name":"demo\\\".pdf"}`}); got != `<file key="file_\"1" name="demo\\\".pdf"/>` {
		t.Fatalf("fileConverter.Convert(escaped) = %q", got)
	}
	if got := (audioMsgConverter{}).Convert(&ConvertContext{RawContent: `{"duration":3500}`}); got != "[Voice: 4s]" {
		t.Fatalf("audioMsgConverter.Convert() = %q", got)
	}
	if got := (videoMsgConverter{}).Convert(&ConvertContext{RawContent: `{"file_key":"file_2","file_name":"clip.mp4","duration":5000,"image_key":"img_cover"}`}); got != `<video key="file_2" name="clip.mp4" duration="5s" cover_image_key="img_cover"/>` {
		t.Fatalf("videoMsgConverter.Convert() = %q", got)
	}
	if got := (videoMsgConverter{}).Convert(&ConvertContext{RawContent: `{"file_key":"file_\"2","file_name":"clip\\\".mp4","duration":5000,"image_key":"img_\"cover"}`}); got != `<video key="file_\"2" name="clip\\\".mp4" duration="5s" cover_image_key="img_\"cover"/>` {
		t.Fatalf("videoMsgConverter.Convert(escaped) = %q", got)
	}
}

func TestMiscConverters(t *testing.T) {
	tests := []struct {
		name string
		got  string
		want string
	}{
		{name: "sticker", got: (stickerConverter{}).Convert(nil), want: "[Sticker]"},
		{name: "video chat", got: (videoChatConverter{}).Convert(nil), want: "[Video call]"},
		{name: "share chat", got: (shareChatConverter{}).Convert(&ConvertContext{RawContent: `{"chat_id":"oc_1"}`}), want: "[Chat card: oc_1]"},
		{name: "share user", got: (shareUserConverter{}).Convert(&ConvertContext{RawContent: `{"user_id":"ou_1"}`}), want: "[User card: ou_1]"},
		{name: "location", got: (locationConverter{}).Convert(&ConvertContext{RawContent: `{"name":"Shanghai"}`}), want: "[Location: Shanghai]"},
		{name: "folder", got: (folderConverter{}).Convert(&ConvertContext{RawContent: `{"file_key":"fld_1","file_name":"Docs"}`}), want: `<folder key="fld_1" name="Docs"/>`},
		{name: "calendar share", got: (calendarEventConverter{}).Convert(&ConvertContext{RawContent: `{"summary":"Review","start_time":"1710500000","end_time":"1710503600","open_calendar_id":"cal_1","open_event_id":"evt_1"}`}), want: "<calendar_share open_calendar_id=\"cal_1\" open_event_id=\"evt_1\">\nReview\n" + formatTimestamp("1710500000") + " ~ " + formatTimestamp("1710503600") + "\n</calendar_share>"},
		{name: "calendar invite", got: (calendarInviteConverter{}).Convert(&ConvertContext{RawContent: `{"summary":"Invite","start_time":"1710500000"}`}), want: "<calendar_invite>\nInvite\n" + formatTimestamp("1710500000") + "\n</calendar_invite>"},
		{name: "general calendar", got: (generalCalendarConverter{}).Convert(&ConvertContext{RawContent: `{"summary":"All Hands"}`}), want: "<calendar>\nAll Hands\n</calendar>"},
		{name: "vote", got: (voteConverter{}).Convert(&ConvertContext{RawContent: `{"topic":"Lunch","options":["A","B"],"status":1}`}), want: "<vote>\nLunch\n• A\n• B\n(Closed)\n</vote>"},
		{name: "hongbao", got: (hongbaoConverter{}).Convert(&ConvertContext{RawContent: `{"text":"恭喜发财"}`}), want: `<hongbao text="恭喜发财"/>`},
		{name: "system", got: (systemConverter{}).Convert(&ConvertContext{RawContent: `{"template":"{from_user} invited {to_chatters} to {name}","from_user":["Alice"],"to_chatters":["Bob","Carol"],"name":"Room A"}`}), want: "Alice invited Bob, Carol to Room A"},
		{name: "invalid user card", got: (shareUserConverter{}).Convert(&ConvertContext{RawContent: `{invalid`}), want: "[Invalid user card JSON]"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.got != tt.want {
				t.Fatalf("%s = %q, want %q", tt.name, tt.got, tt.want)
			}
		})
	}
}

func TestTodoConverter(t *testing.T) {
	got := (todoConverter{}).Convert(&ConvertContext{RawContent: `{"task_id":"task_1","summary":{"title":"Finish report","content":[[{"tag":"text","text":"prepare slides"}]]},"due_time":"1710500000"}`})
	want := "<todo task_id=\"task_1\">\nFinish report\nprepare slides\nDue: " + formatTimestamp("1710500000") + "\n</todo>"
	if got != want {
		t.Fatalf("todoConverter.Convert() = %q, want %q", got, want)
	}
}
