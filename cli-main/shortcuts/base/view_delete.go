// Copyright (c) 2026 Lark Technologies Pte. Ltd.
// SPDX-License-Identifier: MIT

package base

import (
	"context"

	"github.com/larksuite/cli/shortcuts/common"
)

var BaseViewDelete = common.Shortcut{
	Service:     "base",
	Command:     "+view-delete",
	Description: "Delete a view by ID or name",
	Risk:        "high-risk-write",
	Scopes:      []string{"base:view:write_only"},
	AuthTypes:   authTypes(),
	Flags:       []common.Flag{baseTokenFlag(true), tableRefFlag(true), viewRefFlag(true)},
	DryRun:      dryRunViewDelete,
	Execute: func(ctx context.Context, runtime *common.RuntimeContext) error {
		return executeViewDelete(runtime)
	},
}
