// Copyright (c) 2026 Lark Technologies Pte. Ltd.
// SPDX-License-Identifier: MIT

package base

import (
	"encoding/json"
	"fmt"

	"github.com/larksuite/cli/internal/output"
	"github.com/larksuite/cli/shortcuts/common"
)

// handleRoleResponse parses the role API response.
// The response has two layers of code/message:
//   - Outer: SDK-level code/msg (handled by DoAPI for transport errors)
//   - Inner: business-level code/message inside the data object
//
// The data field may be a JSON object (actual behavior) or a JSON string (per doc).
func handleRoleResponse(runtime *common.RuntimeContext, rawBody []byte, action string) error {
	var resp struct {
		Code int             `json:"code"`
		Msg  string          `json:"msg"`
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(rawBody, &resp); err != nil {
		return fmt.Errorf("failed to parse response: %v", err)
	}
	if resp.Code != 0 {
		msg := resp.Msg
		// When outer msg is empty, try to extract error details from data.error.message
		if msg == "" && len(resp.Data) > 0 {
			var errData struct {
				Error struct {
					Message string `json:"message"`
					Hint    string `json:"hint"`
				} `json:"error"`
			}
			if json.Unmarshal(resp.Data, &errData) == nil && errData.Error.Message != "" {
				msg = errData.Error.Message
			}
		}
		return output.ErrAPI(resp.Code, fmt.Sprintf("%s: [%d] %s", action, resp.Code, msg), nil)
	}

	if len(resp.Data) == 0 || string(resp.Data) == "null" || string(resp.Data) == `""` {
		runtime.Out(map[string]any{"success": true}, nil)
		return nil
	}

	// Parse data
	var data any
	if err := json.Unmarshal(resp.Data, &data); err != nil {
		runtime.Out(map[string]any{"data": string(resp.Data)}, nil)
		return nil
	}

	// If data is a string (double-encoded JSON), try to parse it
	if s, ok := data.(string); ok && s != "" {
		var inner any
		if err := json.Unmarshal([]byte(s), &inner); err == nil {
			data = inner
		}
	}

	// Check for business-level error: data may contain its own code/message
	if m, ok := data.(map[string]any); ok {
		if code, exists := m["code"]; exists {
			var codeInt int
			switch v := code.(type) {
			case float64:
				codeInt = int(v)
			case int:
				codeInt = v
			}
			if codeInt != 0 {
				msg, _ := m["message"].(string)
				return output.ErrAPI(codeInt, fmt.Sprintf("%s: [%d] %s", action, codeInt, msg), nil)
			}
			// code == 0, extract the inner data if present
			if innerData, hasInner := m["data"]; hasInner {
				// Inner data might be a double-encoded JSON string
				if s, ok := innerData.(string); ok && s != "" {
					var parsed any
					if err := json.Unmarshal([]byte(s), &parsed); err == nil {
						runtime.Out(parsed, nil)
						return nil
					}
				}
				runtime.Out(innerData, nil)
				return nil
			}
			runtime.Out(map[string]any{"success": true}, nil)
			return nil
		}
	}

	runtime.Out(data, nil)
	return nil
}
