package replicator

import (
	"context"
	"fmt"
	"repli/internal/job"
	"sync"
)

type Replicator struct {
	jobs []job.Runner
}

func New(jobs []job.Runner) *Replicator {
	return &Replicator{jobs: jobs}
}

func (repli *Replicator) StartAll(ctx context.Context) error {
	for _, job := range repli.jobs {
		if err := job.Start(ctx); err != nil {
			return err
		}
	}
	return nil
}

func (repli *Replicator) Errors(ctx context.Context) <-chan error {
	var out = make(chan error, len(repli.jobs))

	var wg sync.WaitGroup
	wg.Add(len(repli.jobs))

	for _, j := range repli.jobs {
		go func(j job.Runner) {
			defer wg.Done()

			for {
				select {
				case <-ctx.Done():
					return
				case err, ok := <-j.Errors():
					if !ok {
						return
					}
					if err == nil {
						continue
					}
					out <- fmt.Errorf("%s:%v", j.Name(), err)
					return
				}
			}
		}(j)
	}

	go func() {
		wg.Wait()
		close(out)
	}()

	return out
}

func (repli *Replicator) StopAll() error {
	for _, job := range repli.jobs {
		if err := job.Stop(); err != nil {
			return err
		}
	}
	return nil
}
