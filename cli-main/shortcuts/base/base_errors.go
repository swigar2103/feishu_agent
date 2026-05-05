// Copyright (c) 2026 Lark Technologies Pte. Ltd.
// SPDX-License-Identifier: MIT

package base

import (
	"fmt"
	"strings"

	"github.com/larksuite/cli/internal/output"
	"github.com/larksuite/cli/internal/util"
)

func handleBaseAPIResult(result interface{}, err error, action string) (map[string]interface{}, error) {
	data, err := handleBaseAPIResultAny(result, err, action)
	if err != nil {
		return nil, err
	}
	dataMap, _ := data.(map[string]interface{})
	return dataMap, nil
}

func handleBaseAPIResultAny(result interface{}, err error, action string) (interface{}, error) {
	if err != nil {
		return nil, output.Errorf(output.ExitAPI, "api_error", "%s: %s", action, err)
	}

	resultMap, _ := result.(map[string]interface{})
	code, _ := util.ToFloat64(resultMap["code"])
	if code == 0 {
		return resultMap["data"], nil
	}

	larkCode := int(code)
	msg := extractDataErrorMessage(resultMap)
	if strings.TrimSpace(msg) == "" {
		msg, _ = resultMap["msg"].(string)
	}

	fullMsg := fmt.Sprintf("%s: [%d] %s", action, larkCode, msg)
	detail := extractErrorDetail(resultMap)
	apiErr := output.ErrAPI(larkCode, fullMsg, detail)
	if apiErr.Detail != nil && apiErr.Detail.Hint == "" {
		if hint := extractErrorHint(resultMap); hint != "" {
			apiErr.Detail.Hint = hint
		}
	}
	return nil, apiErr
}

func extractErrorDetail(resultMap map[string]interface{}) interface{} {
	if detail, ok := nonNilMapValue(resultMap, "error"); ok {
		return detail
	}
	data, _ := resultMap["data"].(map[string]interface{})
	if detail, ok := nonNilMapValue(data, "error"); ok {
		return detail
	}
	return nil
}

func nonNilMapValue(src map[string]interface{}, key string) (interface{}, bool) {
	if src == nil {
		return nil, false
	}
	value, ok := src[key]
	if !ok {
		return nil, false
	}
	switch value.(type) {
	case nil:
		return nil, false
	default:
		return value, true
	}
}

func extractErrorHint(resultMap map[string]interface{}) string {
	if detail, ok := resultMap["error"].(map[string]interface{}); ok {
		if hint, _ := detail["hint"].(string); strings.TrimSpace(hint) != "" {
			return hint
		}
	}
	data, _ := resultMap["data"].(map[string]interface{})
	if detail, ok := data["error"].(map[string]interface{}); ok {
		if hint, _ := detail["hint"].(string); strings.TrimSpace(hint) != "" {
			return hint
		}
	}
	return ""
}

func extractDataErrorMessage(resultMap map[string]interface{}) string {
	data, _ := resultMap["data"].(map[string]interface{})
	if detail, ok := data["error"].(map[string]interface{}); ok {
		if message, _ := detail["message"].(string); strings.TrimSpace(message) != "" {
			return message
		}
	}
	return ""
}
