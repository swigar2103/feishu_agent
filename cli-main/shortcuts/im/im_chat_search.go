// Copyright (c) 2026 Lark Technologies Pte. Ltd.
// SPDX-License-Identifier: MIT

package im

import (
	"context"
	"fmt"
	"io"
	"strconv"
	"strings"

	"github.com/larksuite/cli/internal/output"
	"github.com/larksuite/cli/internal/util"
	"github.com/larksuite/cli/shortcuts/common"
)

var ImChatSearch = common.Shortcut{
	Service:     "im",
	Command:     "+chat-search",
	Description: "Search visible group chats by keyword and/or member open_ids (e.g. look up chat_id by group name); user/bot; supports member/type filters, sorting, and pagination",
	Risk:        "read",
	Scopes:      []string{"im:chat:read"},
	AuthTypes:   []string{"user", "bot"},
	HasFormat:   true,
	Flags: []common.Flag{
		{Name: "query", Desc: "search keyword (max 64 chars)"},
		{Name: "search-types", Desc: "chat types, comma-separated (private, external, public_joined, public_not_joined)"},
		{Name: "member-ids", Desc: "filter by member open_ids, comma-separated"},
		{Name: "is-manager", Type: "bool", Desc: "only show chats you created or manage"},
		{Name: "disable-search-by-user", Type: "bool", Desc: "disable search-by-member-name (default: search by member name first, then group name)"},
		{Name: "sort-by", Desc: "sort field (descending)", Enum: []string{"create_time_desc", "update_time_desc", "member_count_desc"}},
		{Name: "page-size", Type: "int", Default: "20", Desc: "page size (1-100)"},
		{Name: "page-token", Desc: "pagination token for next page"},
	},
	DryRun: func(ctx context.Context, runtime *common.RuntimeContext) *common.DryRunAPI {
		body := buildSearchChatBody(runtime)
		params := buildSearchChatParams(runtime)
		return common.NewDryRunAPI().
			POST("/open-apis/im/v2/chats/search").
			Params(params).
			Body(body)
	},
	Validate: func(ctx context.Context, runtime *common.RuntimeContext) error {
		query := runtime.Str("query")
		memberIDs := runtime.Str("member-ids")
		if query == "" && memberIDs == "" {
			return output.ErrValidation("--query and --member-ids cannot both be empty; provide at least one (e.g. --query \"team-name\" or --member-ids \"ou_xxx\")")
		}
		if query != "" && len([]rune(query)) > 64 {
			return output.ErrValidation("--query exceeds the maximum of 64 characters (got %d)", len([]rune(query)))
		}
		if st := runtime.Str("search-types"); st != "" {
			allowed := map[string]struct{}{
				"private":           {},
				"external":          {},
				"public_joined":     {},
				"public_not_joined": {},
			}
			for _, item := range common.SplitCSV(st) {
				if _, ok := allowed[item]; !ok {
					return output.ErrValidation("invalid --search-types value %q: expected one of private, external, public_joined, public_not_joined", item)
				}
			}
		}
		if mi := runtime.Str("member-ids"); mi != "" {
			ids := common.SplitCSV(mi)
			if len(ids) > 50 {
				return output.ErrValidation("--member-ids exceeds the maximum of 50 (got %d)", len(ids))
			}
			for _, id := range ids {
				if _, err := common.ValidateUserID(id); err != nil {
					return err
				}
			}
		}
		if n := runtime.Int("page-size"); n < 1 || n > 100 {
			return output.ErrValidation("--page-size must be an integer between 1 and 100")
		}
		return nil
	},
	Execute: func(ctx context.Context, runtime *common.RuntimeContext) error {
		body := buildSearchChatBody(runtime)
		params := buildSearchChatParams(runtime)
		resData, err := runtime.CallAPI("POST", "/open-apis/im/v2/chats/search", params, body)
		if err != nil {
			return err
		}

		rawItems, _ := resData["items"].([]interface{})
		totalF, _ := util.ToFloat64(resData["total"])
		total := totalF
		hasMore, pageToken := common.PaginationMeta(resData)

		// Extract MetaData from each item
		var items []map[string]interface{}
		for _, raw := range rawItems {
			item, _ := raw.(map[string]interface{})
			if item == nil {
				continue
			}
			meta, _ := item["meta_data"].(map[string]interface{})
			if meta == nil {
				continue
			}
			items = append(items, meta)
		}

		outData := map[string]interface{}{
			"chats":      items,
			"total":      int(total),
			"has_more":   hasMore,
			"page_token": pageToken,
		}

		runtime.OutFormat(outData, nil, func(w io.Writer) {
			if len(items) == 0 {
				fmt.Fprintln(w, "No matching group chats found.")
				return
			}
			var rows []map[string]interface{}
			for _, m := range items {
				row := map[string]interface{}{
					"chat_id": m["chat_id"],
					"name":    m["name"],
				}
				if desc, _ := m["description"].(string); desc != "" {
					row["description"] = desc
				}
				if ownerID, _ := m["owner_id"].(string); ownerID != "" {
					row["owner_id"] = ownerID
				}
				if chatMode, _ := m["chat_mode"].(string); chatMode != "" {
					row["chat_mode"] = chatMode
				}
				if external, ok := m["external"].(bool); ok {
					row["external"] = external
				}
				if status, _ := m["chat_status"].(string); status != "" {
					row["chat_status"] = status
				}
				if createTime, _ := m["create_time"].(string); createTime != "" {
					row["create_time"] = createTime
				}
				rows = append(rows, row)
			}
			output.PrintTable(w, rows)
			moreHint := ""
			if hasMore {
				moreHint = " (more available, use --page-token to fetch next page"
				if pageToken != "" {
					moreHint += fmt.Sprintf(", page_token: %s", pageToken)
				}
				moreHint += ")"
			}
			fmt.Fprintf(w, "\n%d chat(s) found%s\n", int(total), moreHint)
		})
		return nil
	},
}

func buildSearchChatBody(runtime *common.RuntimeContext) map[string]interface{} {
	body := map[string]interface{}{}

	if query := runtime.Str("query"); query != "" {
		// API behavior: hyphenated keywords should be wrapped in double quotes
		// for more accurate search results.
		body["query"] = normalizeChatSearchQuery(query)
	}

	// Build filter
	filter := map[string]interface{}{}
	if st := runtime.Str("search-types"); st != "" {
		filter["search_types"] = common.SplitCSV(st)
	}
	if mi := runtime.Str("member-ids"); mi != "" {
		filter["member_ids"] = common.SplitCSV(mi)
	}
	if runtime.Bool("is-manager") {
		filter["is_manager"] = true
	}
	if runtime.Bool("disable-search-by-user") {
		filter["disable_search_by_user"] = true
	}
	if len(filter) > 0 {
		body["filter"] = filter
	}

	// Build sorters (always descending)
	if sortBy := runtime.Str("sort-by"); sortBy != "" {
		body["sorter"] = sortBy
	}

	return body
}

func buildSearchChatParams(runtime *common.RuntimeContext) map[string]interface{} {
	params := map[string]interface{}{}
	if n := runtime.Int("page-size"); n > 0 {
		params["page_size"] = n
	} else {
		params["page_size"] = 20
	}
	if pt := runtime.Str("page-token"); pt != "" {
		params["page_token"] = pt
	}
	return params
}

func normalizeChatSearchQuery(query string) string {
	// The search API treats hyphenated keywords specially and expects the whole
	// query to be quoted. Normalize already-quoted input before requoting so we
	// don't emit nested quotes.
	if !strings.Contains(query, "-") {
		return query
	}
	if unquoted, err := strconv.Unquote(query); err == nil {
		query = unquoted
	}
	return strconv.Quote(query)
}
