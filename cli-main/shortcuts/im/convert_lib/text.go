// Copyright (c) 2026 Lark Technologies Pte. Ltd.
// SPDX-License-Identifier: MIT

package convertlib

import (
	"fmt"
	"sort"
	"strings"
)

type textConverter struct{}

func (textConverter) Convert(ctx *ConvertContext) string {
	parsed, err := ParseJSONObject(ctx.RawContent)
	if err != nil {
		return invalidJSONPlaceholder("text")
	}
	text, _ := parsed["text"].(string)
	if text == "" {
		return ctx.RawContent
	}
	return ResolveMentionKeys(text, ctx.MentionMap)
}

type postConverter struct{}

func (postConverter) Convert(ctx *ConvertContext) string {
	parsed, err := ParseJSONObject(ctx.RawContent)
	if err != nil || parsed == nil {
		return invalidJSONPlaceholder("rich text")
	}
	body := unwrapPostLocale(parsed)
	if body == nil {
		return "[Rich text message]"
	}

	var parts []string
	if title, _ := body["title"].(string); title != "" {
		parts = append(parts, title)
	}
	if blocks, _ := body["content"].([]interface{}); len(blocks) > 0 {
		for _, para := range blocks {
			elems, _ := para.([]interface{})
			var line strings.Builder
			for _, el := range elems {
				elem, _ := el.(map[string]interface{})
				line.WriteString(renderPostElem(elem))
			}
			parts = append(parts, line.String())
		}
	}

	result := strings.TrimSpace(strings.Join(parts, "\n"))
	if result == "" {
		return "[Rich text message]"
	}
	return ResolveMentionKeys(result, ctx.MentionMap)
}

func unwrapPostLocale(parsed map[string]interface{}) map[string]interface{} {
	if _, ok := parsed["content"]; ok {
		return parsed
	}
	if _, ok := parsed["title"]; ok {
		return parsed
	}
	for _, locale := range []string{"zh_cn", "en_us", "ja_jp"} {
		if v, ok := parsed[locale]; ok {
			if m, ok := v.(map[string]interface{}); ok {
				return m
			}
		}
	}
	keys := make([]string, 0, len(parsed))
	for key := range parsed {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		v := parsed[key]
		if m, ok := v.(map[string]interface{}); ok {
			return m
		}
	}
	return nil
}

func renderPostElem(el map[string]interface{}) string {
	tag, _ := el["tag"].(string)
	switch tag {
	case "text":
		text, _ := el["text"].(string)
		return text
	case "a":
		text, _ := el["text"].(string)
		href, _ := el["href"].(string)
		if href != "" && text != "" {
			return fmt.Sprintf("[%s](%s)", escapeMDLinkText(text), href)
		}
		if href != "" {
			return href
		}
		return text
	case "at":
		userId, _ := el["user_id"].(string)
		if userId == "@_all" || userId == "all" {
			return "@all"
		}
		name, _ := el["user_name"].(string)
		if name != "" {
			return "@" + name
		}
		return "@" + userId
	case "img":
		key, _ := el["image_key"].(string)
		if key != "" {
			return fmt.Sprintf("[Image: %s]", key)
		}
		return "[Image]"
	case "media":
		key, _ := el["file_key"].(string)
		if key != "" {
			return fmt.Sprintf("[Media: %s]", key)
		}
		return "[Media]"
	case "code_block":
		lang, _ := el["language"].(string)
		code, _ := el["text"].(string)
		if lang != "" {
			return fmt.Sprintf("\n```%s\n%s\n```\n", lang, code)
		}
		return fmt.Sprintf("\n```\n%s\n```\n", code)
	case "hr":
		return "\n---\n"
	default:
		text, _ := el["text"].(string)
		return text
	}
}
