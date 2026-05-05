// Copyright (c) 2026 Lark Technologies Pte. Ltd.
// SPDX-License-Identifier: MIT

package base

import (
	"strings"
	"testing"
)

func TestErrorDetailHelpers(t *testing.T) {
	if value, ok := nonNilMapValue(nil, "error"); ok || value != nil {
		t.Fatalf("nil map should not return value")
	}
	if value, ok := nonNilMapValue(map[string]interface{}{"error": nil}, "error"); ok || value != nil {
		t.Fatalf("nil entry should not return value")
	}
	detail := map[string]interface{}{"message": "boom", "hint": "retry later"}
	if value, ok := nonNilMapValue(map[string]interface{}{"error": detail}, "error"); !ok || value == nil {
		t.Fatalf("expected non-nil detail")
	}
	if got := extractErrorDetail(map[string]interface{}{"error": detail}); got == nil {
		t.Fatalf("expected root detail")
	}
	if got := extractErrorDetail(map[string]interface{}{"data": map[string]interface{}{"error": detail}}); got == nil {
		t.Fatalf("expected nested detail")
	}
	if got := extractErrorHint(map[string]interface{}{"data": map[string]interface{}{"error": detail}}); got != "retry later" {
		t.Fatalf("hint=%q", got)
	}
	if got := extractDataErrorMessage(map[string]interface{}{"data": map[string]interface{}{"error": detail}}); got != "boom" {
		t.Fatalf("message=%q", got)
	}
	if got := extractDataErrorMessage(map[string]interface{}{"data": map[string]interface{}{}}); got != "" {
		t.Fatalf("message=%q", got)
	}
}

func TestHandleBaseAPIResultErrorPaths(t *testing.T) {
	if _, err := handleBaseAPIResultAny(nil, assertErr{}, "list fields"); err == nil || !strings.Contains(err.Error(), "list fields") {
		t.Fatalf("err=%v", err)
	}
	result := map[string]interface{}{
		"code": 190001,
		"msg":  "bad request",
		"data": map[string]interface{}{
			"error": map[string]interface{}{"message": "invalid filter", "hint": "check field name"},
		},
	}
	if _, err := handleBaseAPIResultAny(result, nil, "set filter"); err == nil || !strings.Contains(err.Error(), "invalid filter") || !strings.Contains(err.Error(), "190001") {
		t.Fatalf("err=%v", err)
	}
	if _, err := handleBaseAPIResult(result, nil, "set filter"); err == nil {
		t.Fatalf("expected error")
	}
}

type assertErr struct{}

func (assertErr) Error() string { return "network timeout" }
