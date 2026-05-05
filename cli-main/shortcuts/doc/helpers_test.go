// Copyright (c) 2026 Lark Technologies Pte. Ltd.
// SPDX-License-Identifier: MIT

package doc

import (
	"strings"
	"testing"
)

func TestParseDocumentRef(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name      string
		input     string
		wantKind  string
		wantToken string
		wantErr   string
	}{
		{
			name:      "docx url",
			input:     "https://example.larksuite.com/docx/xxxxxx?from=wiki",
			wantKind:  "docx",
			wantToken: "xxxxxx",
		},
		{
			name:      "wiki url",
			input:     "https://example.larksuite.com/wiki/xxxxxx?from=wiki",
			wantKind:  "wiki",
			wantToken: "xxxxxx",
		},
		{
			name:      "doc url",
			input:     "https://example.larksuite.com/doc/xxxxxx",
			wantKind:  "doc",
			wantToken: "xxxxxx",
		},
		{
			name:      "raw token",
			input:     "xxxxxx",
			wantKind:  "docx",
			wantToken: "xxxxxx",
		},
		{
			name:    "unsupported url",
			input:   "https://example.com/not-a-doc",
			wantErr: "unsupported --doc input",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			got, err := parseDocumentRef(tt.input)
			if tt.wantErr != "" {
				if err == nil {
					t.Fatalf("expected error containing %q, got nil", tt.wantErr)
				}
				if !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("expected error containing %q, got %q", tt.wantErr, err.Error())
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got.Kind != tt.wantKind {
				t.Fatalf("parseDocumentRef(%q) kind = %q, want %q", tt.input, got.Kind, tt.wantKind)
			}
			if got.Token != tt.wantToken {
				t.Fatalf("parseDocumentRef(%q) token = %q, want %q", tt.input, got.Token, tt.wantToken)
			}
		})
	}
}

func TestBuildDriveRouteExtraEscapesJSON(t *testing.T) {
	t.Parallel()

	got, err := buildDriveRouteExtra(`doc-"quoted"`)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := `{"drive_route_token":"doc-\"quoted\""}`
	if got != want {
		t.Fatalf("buildDriveRouteExtra() = %q, want %q", got, want)
	}
}
