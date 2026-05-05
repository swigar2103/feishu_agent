// Copyright (c) 2026 Lark Technologies Pte. Ltd.
// SPDX-License-Identifier: MIT

package base

import (
	"context"

	"github.com/larksuite/cli/shortcuts/common"
)

var BaseFieldSearchOptions = common.Shortcut{
	Service:     "base",
	Command:     "+field-search-options",
	Description: "Search select options of a field",
	Risk:        "read",
	Scopes:      []string{"base:field:read"},
	AuthTypes:   authTypes(),
	Flags: []common.Flag{
		baseTokenFlag(true),
		tableRefFlag(true),
		fieldRefFlag(true),
		{Name: "keyword", Desc: "keyword for option query"},
		{Name: "offset", Type: "int", Default: "0", Desc: "pagination offset"},
		{Name: "limit", Type: "int", Default: "30", Desc: "pagination size"},
	},
	DryRun: dryRunFieldSearchOptions,
	Execute: func(ctx context.Context, runtime *common.RuntimeContext) error {
		return executeFieldSearchOptions(runtime)
	},
}
