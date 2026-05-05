// Copyright (c) 2026 Lark Technologies Pte. Ltd.
// SPDX-License-Identifier: MIT

package common

import (
	"strings"

	"github.com/larksuite/cli/internal/output"
)

// ValidateChatID checks if a chat ID has valid format (oc_ prefix).
// Also extracts token from URL if provided.
func ValidateChatID(input string) (string, error) {
	input = strings.TrimSpace(input)
	if input == "" {
		return "", output.ErrValidation("chat ID cannot be empty")
	}
	// Extract from URL if present
	if strings.Contains(input, "feishu.cn") || strings.Contains(input, "larksuite.com") {
		// Extract oc_xxx from URL
		parts := strings.Split(input, "/")
		for _, part := range parts {
			if strings.HasPrefix(part, "oc_") {
				input = part
				break
			}
		}
	}
	if !strings.HasPrefix(input, "oc_") {
		return "", output.ErrValidation("invalid chat ID format, should start with 'oc_' (e.g., oc_abc123)")
	}
	return input, nil
}

// ValidateUserID checks if a user ID has valid format (ou_ prefix).
func ValidateUserID(input string) (string, error) {
	input = strings.TrimSpace(input)
	if input == "" {
		return "", output.ErrValidation("user ID cannot be empty")
	}
	if !strings.HasPrefix(input, "ou_") {
		return "", output.ErrValidation("invalid user ID format, should start with 'ou_' (e.g., ou_abc123)")
	}
	return input, nil
}
