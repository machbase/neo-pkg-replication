package common

import (
	"fmt"
	"repli/config"
)

func ValidateNoDuplicateNames(cfgs ...config.DBConfig) error {
	cntMap := map[string]int{}
	for _, cfg := range cfgs {
		cntMap[cfg.Name]++
	}
	for name, cnt := range cntMap {
		if cnt > 1 {
			return fmt.Errorf("[source] failed to duplicate name: %q", name)
		}
	}
	return nil
}
