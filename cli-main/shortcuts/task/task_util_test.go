// Copyright (c) 2026 Lark Technologies Pte. Ltd.
// SPDX-License-Identifier: MIT

package task

import (
	"testing"

	"github.com/smartystreets/goconvey/convey"
)

func TestContains(t *testing.T) {
	convey.Convey("contains", t, func() {
		list := []string{"a", "b", "c"}
		convey.So(contains(list, "a"), convey.ShouldBeTrue)
		convey.So(contains(list, "d"), convey.ShouldBeFalse)
		convey.So(contains([]string{}, "a"), convey.ShouldBeFalse)
	})
}
