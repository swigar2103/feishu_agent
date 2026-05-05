// Copyright (c) 2026 Lark Technologies Pte. Ltd.
// SPDX-License-Identifier: MIT

package cmdutil

import (
	"bytes"
	"strings"
	"testing"

	"github.com/larksuite/cli/internal/core"
)

func TestAccessTokensToIdentities(t *testing.T) {
	tests := []struct {
		name   string
		tokens []interface{}
		want   []string
	}{
		{
			name:   "tenant becomes bot",
			tokens: []interface{}{"tenant"},
			want:   []string{"bot"},
		},
		{
			name:   "user stays user",
			tokens: []interface{}{"user"},
			want:   []string{"user"},
		},
		{
			name:   "tenant and user",
			tokens: []interface{}{"tenant", "user"},
			want:   []string{"bot", "user"},
		},
		{
			name:   "empty list",
			tokens: []interface{}{},
			want:   nil,
		},
		{
			name:   "non-string values skipped",
			tokens: []interface{}{"tenant", 42, "user"},
			want:   []string{"bot", "user"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := AccessTokensToIdentities(tt.tokens)
			if len(got) != len(tt.want) {
				t.Fatalf("len: want %d, got %d (%v)", len(tt.want), len(got), got)
			}
			for i := range got {
				if got[i] != tt.want[i] {
					t.Errorf("[%d] want %s, got %s", i, tt.want[i], got[i])
				}
			}
		})
	}
}

func TestPrintIdentity_BotExplicit(t *testing.T) {
	var buf bytes.Buffer
	PrintIdentity(&buf, core.AsBot, nil, false)
	if !strings.Contains(buf.String(), "[identity: bot]") {
		t.Errorf("unexpected output: %s", buf.String())
	}
}

func TestPrintIdentity_BotAutoDetected(t *testing.T) {
	var buf bytes.Buffer
	PrintIdentity(&buf, core.AsBot, nil, true)
	if !strings.Contains(buf.String(), "auto") {
		t.Errorf("expected auto hint, got: %s", buf.String())
	}
}

func TestPrintIdentity_UserWithOpenId(t *testing.T) {
	var buf bytes.Buffer
	cfg := &core.CliConfig{UserOpenId: "ou_abc123"}
	PrintIdentity(&buf, core.AsUser, cfg, false)
	if !strings.Contains(buf.String(), "ou_abc123") {
		t.Errorf("expected UserOpenId in output, got: %s", buf.String())
	}
}

func TestPrintIdentity_UserWithoutOpenId(t *testing.T) {
	var buf bytes.Buffer
	PrintIdentity(&buf, core.AsUser, &core.CliConfig{}, false)
	if !strings.Contains(buf.String(), "[identity: user]") {
		t.Errorf("unexpected output: %s", buf.String())
	}
}

func TestPrintIdentity_UserNilConfig(t *testing.T) {
	var buf bytes.Buffer
	PrintIdentity(&buf, core.AsUser, nil, false)
	if !strings.Contains(buf.String(), "[identity: user]") {
		t.Errorf("unexpected output: %s", buf.String())
	}
}
