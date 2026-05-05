// Copyright (c) 2026 Lark Technologies Pte. Ltd.
// SPDX-License-Identifier: MIT

package task

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/larksuite/cli/internal/output"
	"github.com/larksuite/cli/internal/util"
	"github.com/larksuite/cli/shortcuts/common"
)

var relativeTimeRe = regexp.MustCompile(`^([+-])(\d+)([dwmh])$`)

func isRelativeTime(s string) bool {
	return relativeTimeRe.MatchString(s)
}

func parseRelativeTime(s string) (time.Time, error) {
	matches := relativeTimeRe.FindStringSubmatch(s)
	if len(matches) == 0 {
		return time.Time{}, fmt.Errorf("invalid relative time format: %s", s)
	}

	sign := matches[1]
	amountStr := matches[2]
	unit := matches[3]

	amount, err := strconv.Atoi(amountStr)
	if err != nil {
		return time.Time{}, err
	}

	if sign == "-" {
		amount = -amount
	}

	now := time.Now()
	switch unit {
	case "d":
		return now.AddDate(0, 0, amount), nil
	case "w":
		return now.AddDate(0, 0, amount*7), nil
	case "m":
		return now.Add(time.Duration(amount) * time.Minute), nil
	case "h":
		return now.Add(time.Duration(amount) * time.Hour), nil
	default:
		return time.Time{}, fmt.Errorf("unknown unit: %s", unit)
	}
}

const (
	// ErrCodeTaskInvalidParams is returned when request parameters are invalid.
	ErrCodeTaskInvalidParams = 1470400
	// ErrCodeTaskPermissionDenied is returned when the user has no permission.
	ErrCodeTaskPermissionDenied = 1470403
	// ErrCodeTaskNotFound is returned when the resource is not found.
	ErrCodeTaskNotFound = 1470404
	// ErrCodeTaskConflict is returned when concurrent call conflict.
	ErrCodeTaskConflict = 1470422
	// ErrCodeTaskInternalError is returned when server error occurs.
	ErrCodeTaskInternalError = 1470500
	// ErrCodeTaskAssigneeLimit is returned when assignee limit exceeded.
	ErrCodeTaskAssigneeLimit = 1470610
	// ErrCodeTaskFollowerLimit is returned when follower limit exceeded.
	ErrCodeTaskFollowerLimit = 1470611
	// ErrCodeTasklistMemberLimit is returned when tasklist member limit exceeded.
	ErrCodeTasklistMemberLimit = 1470612
	// ErrCodeTaskReminderExists is returned when reminder already exists.
	ErrCodeTaskReminderExists = 1470613
)

// TaskErrorCode maps Lark error codes to standardized error info.
type TaskErrorInfo struct {
	Type     string
	Message  string
	Hint     string
	ExitCode int
}

var taskErrorMap = map[int]TaskErrorInfo{
	// Generic Task errors from docs
	ErrCodeTaskInvalidParams:    {"validation_error", "Invalid request parameters", "Please check required fields, field lengths, or parameter logic (e.g., reminders require a due date).", output.ExitValidation},
	ErrCodeTaskNotFound:         {"not_found", "Resource not found", "Please verify if the task, tasklist, or group ID is correct and has not been deleted.", output.ExitAPI},
	ErrCodeTaskPermissionDenied: {"permission_error", "Permission denied", "Please check if the calling identity has the necessary edit or read permissions for the resource (task/tasklist).", output.ExitAPI},
	ErrCodeTaskInternalError:    {"api_error", "Internal server error", "Please try again. If the error persists, check the content validity or contact support.", output.ExitAPI},
	ErrCodeTaskConflict:         {"conflict", "Concurrent call conflict", "Avoid making concurrent API calls using the same client_token.", output.ExitAPI},
	ErrCodeTaskAssigneeLimit:    {"api_error", "Assignee limit exceeded", "The current task has reached the maximum number of assignees.", output.ExitAPI},
	ErrCodeTaskFollowerLimit:    {"api_error", "Follower limit exceeded", "The current task has reached the maximum number of followers.", output.ExitAPI},
	ErrCodeTasklistMemberLimit:  {"api_error", "Tasklist member limit exceeded", "The current tasklist has reached the maximum number of members.", output.ExitAPI},
	ErrCodeTaskReminderExists:   {"api_error", "Reminder already exists", "The task already has a reminder set. Remove the existing reminder before adding a new one.", output.ExitAPI},
}

// WrapTaskError wraps a Lark API error into a standardized ExitError based on task-specific rules.
func WrapTaskError(larkCode int, rawMsg string, action string) error {
	info, ok := taskErrorMap[larkCode]
	if !ok {
		// Fallback to generic classification if not in task-specific map
		exitCode, errType, hint := output.ClassifyLarkError(larkCode, rawMsg)

		// Generic message based on type
		genericMsg := ""
		switch errType {
		case "permission":
			genericMsg = "Permission denied"
		case "auth":
			genericMsg = "Authentication failed"
		case "config":
			genericMsg = "Configuration error"
		case "rate_limit":
			genericMsg = "Rate limit exceeded"
		default:
			genericMsg = "API error"
		}

		displayMsg := fmt.Sprintf("%s: %s [%d] (Details: %s)", action, genericMsg, larkCode, rawMsg)

		return &output.ExitError{
			Code: exitCode,
			Detail: &output.ErrDetail{
				Type:    errType,
				Code:    larkCode,
				Message: displayMsg,
				Hint:    hint,
			},
		}
	}

	return &output.ExitError{
		Code: info.ExitCode,
		Detail: &output.ErrDetail{
			Type:    info.Type,
			Code:    larkCode,
			Message: fmt.Sprintf("%s: %s (Details: %s)", action, info.Message, rawMsg),
			Hint:    info.Hint,
		},
	}
}

// HandleTaskApiResult is a wrapper around common.HandleApiResult that applies task-specific error mapping.
func HandleTaskApiResult(result interface{}, err error, action string) (map[string]interface{}, error) {
	if err != nil {
		return nil, err
	}

	resultMap, _ := result.(map[string]interface{})
	codeVal, hasCode := resultMap["code"]
	if !hasCode {
		// Try to see if it's already an error from common.HandleApiResult (e.g. network error)
		data, err := common.HandleApiResult(result, err, action)
		return data, err
	}

	code, _ := util.ToFloat64(codeVal)
	larkCode := int(code)
	if larkCode != 0 {
		rawMsg, _ := resultMap["msg"].(string)
		return nil, WrapTaskError(larkCode, rawMsg, action)
	}

	data, _ := resultMap["data"].(map[string]interface{})
	return data, nil
}

func contains(slice []string, item string) bool {
	for _, s := range slice {
		if s == item {
			return true
		}
	}
	return false
}

// truncateTaskURL removes extra query parameters from task applink, keeping only guid.
func truncateTaskURL(u string) string {
	if u == "" {
		return ""
	}
	if idx := strings.Index(u, "&"); idx != -1 {
		return u[:idx]
	}
	return u
}

// parseTimeFlagSec parses a time flag that can be absolute (ISO 8601, timestamp) or relative (+/- Nd/w/m/h).
// It returns the Unix seconds string.
func parseTimeFlagSec(input string, hint string) (string, error) {
	if isRelativeTime(input) {
		t, err := parseRelativeTime(input)
		if err != nil {
			return "", err
		}
		// Snap to day if unit is days or weeks
		if strings.HasSuffix(input, "d") || strings.HasSuffix(input, "w") {
			if hint == "end" {
				t = time.Date(t.Year(), t.Month(), t.Day(), 23, 59, 59, 0, t.Location())
			} else {
				t = time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, t.Location())
			}
		}
		return fmt.Sprintf("%d", t.Unix()), nil
	}
	return common.ParseTime(input, hint)
}
