// Copyright (c) 2026 Lark Technologies Pte. Ltd.
// SPDX-License-Identifier: MIT

package task

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	larkcore "github.com/larksuite/oapi-sdk-go/v3/core"

	"github.com/larksuite/cli/internal/output"
	"github.com/larksuite/cli/shortcuts/common"
)

var UpdateTask = common.Shortcut{
	Service:     "task",
	Command:     "+update",
	Description: "update task attributes",
	Risk:        "write",
	Scopes:      []string{"task:task:write"},
	AuthTypes:   []string{"user", "bot"},
	HasFormat:   true,

	Flags: []common.Flag{
		{Name: "task-id", Desc: "task id (comma-separated for multiple)", Required: true},
		{Name: "summary", Desc: "task title"},
		{Name: "description", Desc: "task description"},
		{Name: "due", Desc: "due date (ISO 8601 / date:YYYY-MM-DD / relative:+2d / ms timestamp)"},
		{Name: "data", Desc: "JSON payload for task object"},
	},

	DryRun: func(ctx context.Context, runtime *common.RuntimeContext) *common.DryRunAPI {
		body, err := buildTaskUpdateBody(runtime)
		if err != nil {
			return common.NewDryRunAPI().Set("error", err.Error())
		}
		taskIds := strings.Split(runtime.Str("task-id"), ",")
		taskId := url.PathEscape(strings.TrimSpace(taskIds[0]))
		return common.NewDryRunAPI().
			PATCH("/open-apis/task/v2/tasks/" + taskId).
			Params(map[string]interface{}{"user_id_type": "open_id"}).
			Body(body)
	},

	Execute: func(ctx context.Context, runtime *common.RuntimeContext) error {
		body, err := buildTaskUpdateBody(runtime)
		if err != nil {
			return WrapTaskError(ErrCodeTaskInvalidParams, err.Error(), "update task")
		}

		taskIds := strings.Split(runtime.Str("task-id"), ",")
		var updatedTasks []map[string]interface{}

		for _, taskId := range taskIds {
			taskId = strings.TrimSpace(taskId)
			if taskId == "" {
				continue
			}

			queryParams := make(larkcore.QueryParams)
			queryParams.Set("user_id_type", "open_id")

			apiResp, err := runtime.DoAPI(&larkcore.ApiReq{
				HttpMethod:  http.MethodPatch,
				ApiPath:     "/open-apis/task/v2/tasks/" + url.PathEscape(taskId),
				QueryParams: queryParams,
				Body:        body,
			})

			var result map[string]interface{}
			if err == nil {
				if parseErr := json.Unmarshal(apiResp.RawBody, &result); parseErr != nil {
					return fmt.Errorf("failed to parse response for task %s: %v", taskId, parseErr)
				}
			}

			data, err := HandleTaskApiResult(result, err, "update task "+taskId)
			if err != nil {
				return err
			}

			taskObj, _ := data["task"].(map[string]interface{})
			if taskObj != nil {
				updatedTasks = append(updatedTasks, taskObj)
			}
		}

		var tasks []map[string]interface{}
		for _, task := range updatedTasks {
			guid, _ := task["guid"].(string)
			urlVal, _ := task["url"].(string)
			urlVal = truncateTaskURL(urlVal)
			tasks = append(tasks, map[string]interface{}{
				"guid": guid,
				"url":  urlVal,
			})
		}
		// Standardized write output: return resource identifiers
		outData := map[string]interface{}{
			"tasks": tasks,
		}

		runtime.OutFormat(outData, &output.Meta{Count: len(updatedTasks)}, func(w io.Writer) {
			for _, task := range updatedTasks {
				guid, _ := task["guid"].(string)
				summary, _ := task["summary"].(string)
				urlVal, _ := task["url"].(string)
				urlVal = truncateTaskURL(urlVal)
				fmt.Fprintf(w, "✅ Task updated successfully!\n")
				fmt.Fprintf(w, "Task ID: %s\n", guid)
				if summary != "" {
					fmt.Fprintf(w, "Summary: %s\n", summary)
				}
				if urlVal != "" {
					fmt.Fprintf(w, "Task URL: %s\n", urlVal)
				}
				fmt.Fprintln(w, strings.Repeat("-", 20))
			}
		})
		return nil
	},
}

func buildTaskUpdateBody(runtime *common.RuntimeContext) (map[string]interface{}, error) {
	taskObj := make(map[string]interface{})
	var updateFields []string

	if dataStr := runtime.Str("data"); dataStr != "" {
		if err := json.Unmarshal([]byte(dataStr), &taskObj); err != nil {
			return nil, fmt.Errorf("--data must be a valid JSON object: %v", err)
		}
		// If data is provided, assume keys are update fields
		for k := range taskObj {
			updateFields = append(updateFields, k)
		}
	}

	if summary := runtime.Str("summary"); summary != "" {
		taskObj["summary"] = summary
		if !contains(updateFields, "summary") {
			updateFields = append(updateFields, "summary")
		}
	}

	if desc := runtime.Str("description"); desc != "" {
		taskObj["description"] = desc
		if !contains(updateFields, "description") {
			updateFields = append(updateFields, "description")
		}
	}

	if dueStr := runtime.Str("due"); dueStr != "" {
		dueObj, err := parseTaskTime(dueStr)
		if err != nil {
			return nil, fmt.Errorf("failed to parse due time: %v", err)
		}
		taskObj["due"] = dueObj
		if !contains(updateFields, "due") {
			updateFields = append(updateFields, "due")
		}
	}

	if len(updateFields) == 0 {
		return nil, fmt.Errorf("no fields to update")
	}

	return map[string]interface{}{
		"task":          taskObj,
		"update_fields": updateFields,
	}, nil
}
