/* pj_vtap: see ifspec.ifs. The whole model is "tell the engine what my inputs are".

   When it is called:
   - as an ordinary analog model, at every pass of the solver. It adds nothing to the
     circuit. Only at time 0 does it report (the starting voltages).
   - once more after each ACCEPTED time step (STEP_PENDING), because it declared itself
     "irreversible" with a high number: ngspice calls such models, highest number first,
     before the code parts (which have the low numbers) are advanced over the same step.
     So a part that is advanced to time T already finds the voltages of T.
   The value ngspice hands a model in that call is the one from the solver's last pass
   over the step, which is within the solver's own tolerance of the final answer.
*/

#define PJ_VTAP_MAX 64
#define PJ_VTAP_ORDER_BASE 1000000u

extern void   pj_tap_put(int id, double time, int count, const double *values, int accepted);
extern double pj_tap_want(int id);

void cm_pj_vtap(ARGS)
{
    double values[PJ_VTAP_MAX];
    int    count = PORT_SIZE(in);
    int    i;

    if (count > PJ_VTAP_MAX)
        count = PJ_VTAP_MAX;

    if (INIT)
        cm_irreversible(PJ_VTAP_ORDER_BASE + (unsigned int) PARAM(id));

    /* The part said when it will measure next: ask for a time point there. This has to be
       asked again in every pass, ngspice forgets it from step to step. */
    if (CALL_TYPE == ANALOG && TIME > 0.0) {
        double want = pj_tap_want(PARAM(id));

        if (want > 0.0)
            cm_analog_set_temp_bkpt(want);
    }

    if (CALL_TYPE == STEP_PENDING || TIME <= 0.0) {
        for (i = 0; i < count; i++)
            values[i] = INPUT(in[i]);

        pj_tap_put(PARAM(id), TIME, count, values, CALL_TYPE == STEP_PENDING);
    }
}
