// Copyright (c) 2026 Lark Technologies Pte. Ltd.
// SPDX-License-Identifier: MIT

package base

import (
	"context"

	"github.com/larksuite/cli/shortcuts/common"
)

var BaseBaseGet = common.Shortcut{
	Service:     "base",
	Command:     "+base-get",
	Description: "Get a base resource",
	Risk:        "read",
	Scopes:      []string{"base:app:read"},
	AuthTypes:   authTypes(),
	Flags:       []common.Flag{baseTokenFlag(true)},
	DryRun:      dryRunBaseGet,
	Execute: func(ctx context.Context, runtime *common.RuntimeContext) error {
		return executeBaseGet(runtime)
	},
}
