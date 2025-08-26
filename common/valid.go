package common

import (
	"fmt"
	"repli/config"
)

func ValidateNoEmpty(cfgs ...config.DBConfig) error {
	if len(cfgs) == 0 {
		return fmt.Errorf("config is empty")
	}
	return nil
}

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
