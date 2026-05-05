// Copyright (c) 2026 Lark Technologies Pte. Ltd.
// SPDX-License-Identifier: MIT

package doctor

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/spf13/cobra"

	"github.com/larksuite/cli/internal/cmdutil"
	"github.com/larksuite/cli/internal/core"
)

func TestNewCmdDoctor_FlagParsing(t *testing.T) {
	f, _, _, _ := cmdutil.TestFactory(t, &core.CliConfig{
		AppID: "test-app", AppSecret: "test-secret", Brand: core.BrandFeishu,
	})

	cmd := NewCmdDoctor(f)
	cmd.SetArgs([]string{"--offline"})

	// We only test flag parsing; skip actual execution by intercepting RunE.
	var gotOffline bool
	origRunE := cmd.RunE
	cmd.RunE = func(cmd2 *cobra.Command, args []string) error {
		v, _ := cmd2.Flags().GetBool("offline")
		gotOffline = v
		return nil
	}
	_ = origRunE

	if err := cmd.Execute(); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !gotOffline {
		t.Error("expected --offline to be true")
	}
}

func TestFinishDoctor(t *testing.T) {
	t.Run("all pass returns nil", func(t *testing.T) {
		f, stdout, _, _ := cmdutil.TestFactory(t, nil)
		checks := []checkResult{
			pass("check1", "ok"),
			skip("check2", "skipped"),
		}
		err := finishDoctor(f, checks)
		if err != nil {
			t.Fatalf("expected nil, got %v", err)
		}

		var result struct {
			OK bool `json:"ok"`
		}
		json.Unmarshal(stdout.Bytes(), &result)
		if !result.OK {
			t.Error("expected ok=true")
		}
	})

	t.Run("any fail returns error", func(t *testing.T) {
		f, stdout, _, _ := cmdutil.TestFactory(t, nil)
		checks := []checkResult{
			pass("check1", "ok"),
			fail("check2", "bad", "fix it"),
		}
		err := finishDoctor(f, checks)
		if err == nil {
			t.Fatal("expected error, got nil")
		}

		var result struct {
			OK bool `json:"ok"`
		}
		json.Unmarshal(stdout.Bytes(), &result)
		if result.OK {
			t.Error("expected ok=false")
		}
	})
}

func TestNetworkChecks_Offline(t *testing.T) {
	ep := core.Endpoints{Open: "https://open.feishu.cn", MCP: "https://mcp.feishu.cn"}
	opts := &DoctorOptions{Ctx: context.Background(), Offline: true}
	checks := networkChecks(opts.Ctx, opts, ep)
	if len(checks) != 2 {
		t.Fatalf("expected 2 checks, got %d", len(checks))
	}
	for _, c := range checks {
		if c.Status != "skip" {
			t.Errorf("expected skip, got %s for %s", c.Status, c.Name)
		}
	}
}
