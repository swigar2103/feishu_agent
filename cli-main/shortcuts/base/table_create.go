// Copyright (c) 2026 Lark Technologies Pte. Ltd.
// SPDX-License-Identifier: MIT

package base

import (
	"context"

	"github.com/larksuite/cli/shortcuts/common"
)

var BaseTableCreate = common.Shortcut{
	Service:     "base",
	Command:     "+table-create",
	Description: "Create a table and optional fields/views",
	Risk:        "write",
	Scopes:      []string{"base:table:create", "base:field:read", "base:field:create", "base:field:update", "base:view:write_only"},
	AuthTypes:   authTypes(),
	Flags: []common.Flag{
		baseTokenFlag(true),
		{Name: "name", Desc: "table name", Required: true},
		{Name: "view", Desc: "view JSON object/array for create"},
		{Name: "fields", Desc: "field JSON array for create"},
	},
	Validate: func(ctx context.Context, runtime *common.RuntimeContext) error {
		return validateTableCreate(runtime)
	},
	DryRun: dryRunTableCreate,
	Execute: func(ctx context.Context, runtime *common.RuntimeContext) error {
		return executeTableCreate(runtime)
	},
}
